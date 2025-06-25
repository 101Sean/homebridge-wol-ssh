// index.js
const axios   = require('axios')
const cheerio = require('cheerio')
const { Client } = require('ssh2')

// axios 요청 디버그 (원할 때만 활성화)
 axios.interceptors.request.use(config => {
   console.log('---- axios 요청 디버그 ----')
   console.log(config.method.toUpperCase(), config.url)
   console.log('Headers:', JSON.stringify(config.headers, null, 2))
   console.log('Body:', config.data)
   console.log('---------------------------')
   return config
 })

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
            try {
                await this.doWake()
                this.log.info('WOL 실행 성공')
            } catch (e) {
                this.log.error('WOL 오류', e.message)
                throw e
            }
        } else {
            return new Promise((resolve, reject) => {
                const url = new URL(this.config.domain)
                const conn = new Client()
                conn.on('ready', () => {
                    this.log.info('SSH 연결됨, 종료 명령 전송')
                    conn.exec('shutdown /s /t 0', (err, stream) => {
                        if (err) return reject(err)
                        stream.on('close', () => {
                            this.log.info('SSH 종료 성공')
                            conn.end()
                            resolve()
                        })
                    })
                })
                    .on('error', err => {
                        this.log.error('SSH 연결 오류', err.message)
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

        // 폼 바디 생성 + 공통 헤더 유틸
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

        // 1) 로그인 → 세션 ID 추출
        const loginData = {
            username, passwd: password,
            init_status:1, captcha_on:1, default_passwd:'admin',
            Referer: `${origin}/sess-bin/login_session.cgi?noauto=1`
        }
        const { body: loginBody, headers: loginHeaders } = makeForm(loginData)
        const loginResp = await axios.post(
            `${origin}/sess-bin/login_handler.cgi`,
            loginBody,
            { headers: loginHeaders }
        )
        // setCookie('ID') 패턴에서 추출
        const match = loginResp.data.match(/setCookie\('([^']+)'\)/)
        if (!match) throw new Error('세션 쿠키 획득 실패')
        const sessionId = match[1].trim()

        // 공통 GET 헤더 (Accept 포함)
        const getHeaders = {
            'Accept':   'text/html',
            Host:       host,
            Connection: 'close',
            Cookie:     `efm_session_id=${sessionId}`
        }

        // 2) MAC 목록 조회 → 파싱
        const listResp = await axios.get(
            `${origin}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`,
            { headers: getHeaders }
        )
        const $ = cheerio.load(listResp.data)
        let mac = null
        $('tr.wol_main_tr').each((_, tr) => {
            const desc = $(tr).find('td').eq(2).find('.wol_main_span').text().trim()
            if (desc === targetName) {
                mac = $(tr).find('input[name="wakeupchk"]').attr('value')
                return false
            }
        })
        if (!mac) throw new Error(`"${targetName}"에 해당하는 MAC 주소 파싱 실패`)

        // 3) WOL POST
        const wakeData = {
            tmenu: 'iframe',
            smenu: 'expertconfwollist',
            nomore: 0,
            wakeupchk: mac,
            act: 'wake'
        }
        const { body: wakeBody, headers: wakeHeaders } = makeForm(wakeData)
        wakeHeaders.Cookie = `efm_session_id=${sessionId}`

        await axios.post(
            `${origin}/sess-bin/timepro.cgi`,
            wakeBody,
            { headers: wakeHeaders }
        )
    }
}
