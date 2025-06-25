// index.js
const http  = require('http')
const https = require('https')
const axios = require('axios')
const cheerio = require('cheerio')
const { Client } = require('ssh2')

// axios 인스턴스: 불완전 HTTP 헤더도 허용
const axiosInstance = axios.create({
    httpAgent:  new http.Agent({ allowInsecureHTTPParser: true }),
    httpsAgent: new https.Agent({ allowInsecureHTTPParser: true }),
})

// 디버그용 전역 인터셉터 (로그가 너무 많으면 주석 처리)
// axiosInstance.interceptors.request.use(cfg => {
//   console.log('▶▶▶ REQUEST ▶▶▶')
//   console.log(cfg.method.toUpperCase(), cfg.url)
//   console.log('Headers:', cfg.headers)
//   console.log('Body:', cfg.data)
//   console.log('---------------------')
//   return cfg
// })

let Service, Characteristic, UUID

module.exports = (api) => {
    Service        = api.hap.Service
    Characteristic = api.hap.Characteristic
    UUID           = api.hap.uuid

    api.registerPlatform(
        'homebridge-wol-ssh',
        'WolSshPlatform',
        WolSshPlatform,
        true
    )
}

class WolSshPlatform {
    constructor(log, config, api) {
        this.log    = log
        this.config = config
        this.api    = api
        api.on('didFinishLaunching', () => this.publishSwitch())
    }

    publishSwitch() {
        const uuid = UUID.generate(this.config.domain)
        const acc  = new this.api.platformAccessory(this.config.name, uuid)
        acc.category = this.api.hap.Categories.SWITCH

        const sw = acc.addService(Service.Switch, this.config.name)
        sw.getCharacteristic(Characteristic.On)
            .onGet(() => false)
            .onSet(value => this.handlePower(value))

        this.api.publishExternalAccessories('homebridge-wol-ssh', [acc])
        this.log.info('✅ Published WOL-SSH Switch:', this.config.name)
    }

    async handlePower(on) {
        if (on) {
            this.log.info('[handlePower] WOL 시작')
            try {
                await this.doWake()
                this.log.info('[handlePower] WOL 실행 성공')
            } catch (e) {
                this.log.error('[handlePower] WOL 오류:', e.message)
                throw e
            }
        } else {
            this.log.info('[handlePower] SSH 종료 시작')
            return new Promise((resolve, reject) => {
                const url = new URL(this.config.domain)
                const conn = new Client()
                conn.on('ready', () => {
                    this.log.info('[SSH] 연결됨, shutdown 명령 전송')
                    conn.exec('shutdown /s /t 0', (err, stream) => {
                        if (err) return reject(err)
                        stream.on('close', () => {
                            this.log.info('[SSH] 종료 성공')
                            conn.end()
                            resolve()
                        })
                    })
                })
                    .on('error', err => {
                        this.log.error('[SSH] 연결 오류:', err.message)
                        reject(err)
                    })
                    .connect({
                        host:     url.hostname,
                        port:     this.config.sshPort,
                        username: this.config.username,
                        password: this.config.password,
                    })
            })
        }
    }

    async doWake() {
        const { domain, wolPort, username, password, targetName } = this.config
        const url    = new URL(domain)
        url.port     = wolPort
        const origin = url.origin           // "http://host:port"
        const host   = url.host             // "host:port"

        this.log.info('[doWake] URL 세팅:', origin)

        // 폼 바디 및 헤더 생성 유틸
        const makeForm = data => {
            const body = new URLSearchParams(data).toString()
            return {
                body,
                headers: {
                    'Accept':            'text/html',
                    Host:                host,
                    Connection:          'close',
                    'Content-Type':      'application/x-www-form-urlencoded',
                    'Content-Length':    Buffer.byteLength(body).toString()
                }
            }
        }

        // 1) 로그인
        this.log.info('[doWake] 1) 로그인 요청 준비')
        const loginData = {
            username, passwd: password,
            init_status:1, captcha_on:1, default_passwd:'admin',
            Referer: `${origin}/sess-bin/login_session.cgi?noauto=1`
        }
        const { body: loginBody, headers: loginHeaders } = makeForm(loginData)
        this.log.debug('[doWake] 로그인 헤더:', loginHeaders)
        this.log.debug('[doWake] 로그인 바디:', loginBody)

        const loginResp = await axiosInstance.post(
            `${origin}/sess-bin/login_handler.cgi`,
            loginBody,
            { headers: loginHeaders }
        )
        this.log.info('[doWake] 1) 로그인 응답 수신, HTML 길이:', loginResp.data.length)

        // 세션 ID 추출
        const match = loginResp.data.match(/setCookie\('([^']+)'\)/)
        if (!match) {
            this.log.error('[doWake] 세션 쿠키 패턴 매칭 실패')
            throw new Error('세션 쿠키 획득 실패')
        }
        const sessionId = match[1].trim()
        this.log.info('[doWake] 세션 ID:', sessionId)

        // 2) MAC 목록 조회
        this.log.info('[doWake] 2) MAC 목록 GET 요청 준비')
        const getHeaders = {
            'Accept':   'text/html',
            Host:       host,
            Connection: 'close',
            Cookie:     `efm_session_id=${sessionId}`
        }
        this.log.debug('[doWake] GET 헤더:', getHeaders)

        const listResp = await axiosInstance.get(
            `${origin}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`,
            { headers: getHeaders }
        )
        this.log.info('[doWake] 2) 목록 응답 수신, HTML 길이:', listResp.data.length)

        // 파싱
        const $ = cheerio.load(listResp.data)
        let mac = null
        $('tr.wol_main_tr').each((_, tr) => {
            const desc = $(tr).find('td').eq(2).find('.wol_main_span').text().trim()
            if (desc === targetName) {
                mac = $(tr).find('input[name="wakeupchk"]').attr('value')
                return false
            }
        })
        if (!mac) {
            this.log.error('[doWake] MAC 파싱 실패, targetName:', targetName)
            throw new Error(`"${targetName}"에 해당하는 MAC 주소 파싱 실패`)
        }
        this.log.info('[doWake] 대상 MAC 주소:', mac)

        // 3) WOL POST
        this.log.info('[doWake] 3) WOL POST 요청 준비')
        const wakeData = {
            tmenu:'iframe',
            smenu:'expertconfwollist',
            nomore:0,
            wakeupchk:mac,
            act:'wake'
        }
        const { body: wakeBody, headers: wakeHeaders } = makeForm(wakeData)
        wakeHeaders.Cookie = `efm_session_id=${sessionId}`
        this.log.debug('[doWake] WOL 헤더:', wakeHeaders)
        this.log.debug('[doWake] WOL 바디:', wakeBody)

        const wakeResp = await axiosInstance.post(
            `${origin}/sess-bin/timepro.cgi`,
            wakeBody,
            { headers: wakeHeaders }
        )
        this.log.info('[doWake] 3) WOL 응답 상태코드:', wakeResp.status)
    }
}
