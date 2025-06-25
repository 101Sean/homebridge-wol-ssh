// index.js
const http    = require('http')
const https   = require('https')
const cheerio = require('cheerio')
const { URL } = require('url')
const { Client } = require('ssh2')

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
            .onSet(val => this.handlePower(val))

        this.api.publishExternalAccessories('homebridge-wol-ssh', [acc])
        this.log.info('✅ Published WOL-SSH Switch:', this.config.name)
    }

    async handlePower(on) {
        if (on) {
            this.log.info('[handlePower] WOL 시작')
            try {
                await this.doWake()
                this.log.info('[handlePower] WOL 완료')
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

    // raw http/https 요청 유틸
    httpRequest(options, body = '') {
        return new Promise((resolve, reject) => {
            const isHttps = options.protocol === 'https:'
            const lib     = isHttps ? https : http
            options.agent = new lib.Agent({ allowInsecureHTTPParser: true })
            const req = lib.request(options, res => {
                let data = ''
                res.on('data', chunk => data += chunk)
                res.on('end', () => {
                    this.log.debug(`[httpRequest] ${options.method} ${options.path} -> ${res.statusCode}`)
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: data })
                })
            })
            req.on('error', reject)
            if (body) req.write(body)
            req.end()
        })
    }

    async doWake() {
        const { domain, wolPort, username, password, targetName } = this.config
        const url = new URL(domain)
        url.port = wolPort
        const origin = url.origin    // "http://host:port"
        const host   = url.host      // "host:port"

        this.log.info('[doWake] URL:', origin)

        // --- 1) 로그인 ---
        const loginPath = `${url.pathname}/sess-bin/login_handler.cgi`
        const loginData = new URLSearchParams({
            username, passwd: password,
            init_status:1, captcha_on:1, default_passwd:'admin',
            Referer: `${origin}/sess-bin/login_session.cgi?noauto=1`
        }).toString()
        this.log.info('[doWake] 1) 로그인 요청')
        const loginResp = await this.httpRequest({
            protocol:  url.protocol,
            hostname:  url.hostname,
            port:      url.port,
            method:    'POST',
            path:      loginPath,
            headers: {
                'Accept':            'text/html',
                'Host':              host,
                'Connection':        'close',
                'Content-Type':      'application/x-www-form-urlencoded',
                'Content-Length':    Buffer.byteLength(loginData)
            }
        }, loginData)

        this.log.debug('[doWake] 로그인 응답 헤더:', loginResp.headers)
        const match = loginResp.body.match(/setCookie\('([^']+)'\)/)
        if (!match) throw new Error('세션 쿠키 획득 실패')
        const sessionId = match[1].trim()
        this.log.info('[doWake] 세션 ID:', sessionId)

        // --- 2) MAC 목록 조회 ---
        const listPath = `${url.pathname}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`
        this.log.info('[doWake] 2) 목록 요청')
        const listResp = await this.httpRequest({
            protocol: url.protocol,
            hostname: url.hostname,
            port:     url.port,
            method:   'GET',
            path:     listPath,
            headers: {
                'Accept':     'text/html',
                'Host':       host,
                'Connection': 'close',
                'Cookie':     `efm_session_id=${sessionId}`
            }
        })
        this.log.debug('[doWake] 목록 응답 길이:', listResp.body.length)

        const $ = cheerio.load(listResp.body)
        let mac = null
        $('tr.wol_main_tr').each((_, tr) => {
            const desc = $(tr).find('td').eq(2).find('.wol_main_span').text().trim()
            if (desc === targetName) {
                mac = $(tr).find('input[name="wakeupchk"]').attr('value')
                return false
            }
        })
        if (!mac) throw new Error(`MAC 파싱 실패: ${targetName}`)
        this.log.info('[doWake] 대상 MAC:', mac)

        // --- 3) WOL POST ---
        const wakePath = `${url.pathname}/sess-bin/timepro.cgi`
        const wakeData = new URLSearchParams({
            tmenu:'iframe', smenu:'expertconfwollist',
            nomore:0, wakeupchk:mac, act:'wake'
        }).toString()
        this.log.info('[doWake] 3) WOL 요청')
        const wakeResp = await this.httpRequest({
            protocol: url.protocol,
            hostname: url.hostname,
            port:     url.port,
            method:   'POST',
            path:     wakePath,
            headers: {
                'Accept':         'text/html',
                'Host':           host,
                'Connection':     'close',
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(wakeData),
                'Cookie':         `efm_session_id=${sessionId}`
            }
        }, wakeData)
        this.log.info('[doWake] WOL 응답 코드:', wakeResp.statusCode)
    }
}
