// index.js
const http    = require('http')
const https   = require('https')
const cheerio = require('cheerio')
const { URL } = require('url')
const { Client } = require('ssh2')

let Service, Characteristic, UUID

module.exports = api => {
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
        // SSH 접속용 사용자 (sshUsername 설정이 없으면 username 사용)
        this.sshUser = config.sshUsername || config.username
        api.on('didFinishLaunching', () => this.publishSwitch())
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

        this.api.publishExternalAccessories(
            'homebridge-wol-ssh',
            [acc]
        )

        this.log.info('✅ Published WOL-SSH Switch:', this.config.name)
    }

    async handlePower(on) {
        if (on) {
            return this._powerOn()
        } else {
            return this._powerOff()
        }
    }

    async _powerOn() {
        this.log.info('[handlePower] WOL 시작')
        try {
            await this.doWake()
            this.log.info('[handlePower] WOL 완료')
        } catch (e) {
            this.log.error('[handlePower] WOL 오류:', e.message)
            throw e
        }
    }

    _powerOff() {
        this.log.info('[handlePower] SSH 종료 시작')
        const { hostname } = new URL(this.config.domain)
        const port          = this.config.sshPort

        this.log.debug('[SSH] Hostname:', hostname)
        this.log.debug('[SSH] Port:', port)

        return new Promise((resolve, reject) => {
            const conn = new Client()

            conn.on('ready', () => {
                this.log.info('[SSH] 연결됨')
                conn.exec('shutdown /s /t 0', (err, stream) => {
                    if (err) {
                        this.log.error('[SSH] exec 오류:', err.message)
                        return reject(err)
                    }

                    stream
                        .on('close', (code, signal) => {
                            this.log.info(
                                `[SSH] 종료 성공 (code=${code}, signal=${signal})`
                            )
                            conn.end()
                            resolve()
                        })
                        .on('data', data =>
                            this.log.debug('[SSH] stdout:', data.toString())
                        )
                        .stderr.on('data', data =>
                        this.log.warn('[SSH] stderr:', data.toString())
                    )
                })
            })
                .on('error', err => {
                    this.log.error('[SSH] 연결 오류:', err.message)
                    reject(err)
                })
                .connect((() => {
                    const opts = {
                        host:     hostname,
                        port,
                        username: this.config.username,
                    }
                    if (this.config.password) {
                        opts.password = this.config.password
                    } else {
                        // SSH agent 또는 개인키 사용 (기본 SSH_AUTH_SOCK 이용)
                        opts.agent = process.env.SSH_AUTH_SOCK
                        // 또는 privateKey 사용 시:
                        // opts.privateKey = require('fs').readFileSync('/home/sean/.ssh/id_rsa')
                    }
                    return opts
                })())
        })
    }

    httpRequest(options, body = '') {
        options.insecureHTTPParser = true

        return new Promise((resolve, reject) => {
            const lib        =
                options.protocol === 'https:' ? https : http
            options.agent    = new lib.Agent({ allowInsecureHTTPParser: true })

            this.log.debug('[httpRequest] options:', options)
            if (body) this.log.debug('[httpRequest] body:', body)

            const req = lib.request(options, res => {
                let data = ''

                res.on('data', chunk => (data += chunk))
                res.on('end', () => {
                    this.log.debug(
                        `[httpRequest] response ${options.method} ${options.path} -> ${res.statusCode}`
                    )
                    resolve({
                        statusCode: res.statusCode,
                        headers:    res.headers,
                        body:       data
                    })
                })
            })

            req.on('error', err => {
                this.log.error('[httpRequest] error:', err.message)
                reject(err)
            })

            if (body) req.write(body)
            req.end()
        })
    }

    async doWake() {
        const { domain, wolPort, username, password, targetName } =
            this.config
        const url = new URL(domain)
        url.port   = wolPort

        const origin = url.origin
        const host   = url.host

        this.log.info('[doWake] URL:', origin)

        // 1) 로그인
        const loginPath = `${url.pathname}/sess-bin/login_handler.cgi`
        const loginBody = new URLSearchParams({
            username,
            passwd:         password,
            init_status:    1,
            captcha_on:     1,
            default_passwd: 'admin',
            Referer:        `${origin}/sess-bin/login_session.cgi?noauto=1`
        }).toString()

        this.log.info('[doWake] 1) 로그인 요청')
        const loginResp = await this.httpRequest(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port:     url.port,
                method:   'POST',
                path:     loginPath,
                headers: {
                    Accept:         'text/html',
                    Host:           host,
                    Connection:     'close',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length':
                        Buffer.byteLength(loginBody)
                }
            },
            loginBody
        )

        this.log.debug('[doWake] 로그인 headers:', loginResp.headers)
        const match = loginResp.body.match(
            /setCookie\('([^']+)'\)/
        )
        if (!match) throw new Error('세션 쿠키 파싱 실패')

        const sessionId = match[1].trim()
        this.log.info('[doWake] sessionId:', sessionId)

        // 2) MAC 목록 조회
        const listPath =
            `${url.pathname}/sess-bin/timepro.cgi?` +
            `tmenu=iframe&smenu=expertconfwollist`

        this.log.info('[doWake] 2) MAC 목록 요청')
        const listResp = await this.httpRequest(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port:     url.port,
                method:   'GET',
                path:     listPath,
                headers: {
                    Accept:     'text/html',
                    Host:       host,
                    Connection: 'close',
                    Cookie:     `efm_session_id=${sessionId}`
                }
            }
        )

        this.log.debug(
            '[doWake] 목록 응답 길이:',
            listResp.body.length
        )

        const $ = cheerio.load(listResp.body)
        let mac = null

        $('tr.wol_main_tr')
            .each((_, tr) => {
                const desc = $(tr)
                    .find('td')
                    .eq(2)
                    .find('.wol_main_span')
                    .text()
                    .trim()

                if (desc === targetName) {
                    mac = $(tr)
                        .find('input[name="wakeupchk"]')
                        .attr('value')
                    return false
                }
            })

        if (!mac) {
            this.log.error('[doWake] MAC 파싱 실패:', targetName)
            throw new Error(`MAC 파싱 실패: ${targetName}`)
        }

        this.log.info('[doWake] MAC:', mac)

        // 3) WOL POST
        const wakePath = `${url.pathname}/sess-bin/timepro.cgi`
        const wakeBody = new URLSearchParams({
            tmenu:      'iframe',
            smenu:      'expertconfwollist',
            nomore:     0,
            wakeupchk:  mac,
            act:        'wake'
        }).toString()

        this.log.info('[doWake] 3) WOL 요청')
        const wakeResp = await this.httpRequest(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port:     url.port,
                method:   'POST',
                path:     wakePath,
                headers: {
                    Accept:         'text/html',
                    Host:           host,
                    Connection:     'close',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length':
                        Buffer.byteLength(wakeBody),
                    Cookie:         `efm_session_id=${sessionId}`
                }
            },
            wakeBody
        )

        this.log.info('[doWake] WOL status:', wakeResp.statusCode)
    }
}
