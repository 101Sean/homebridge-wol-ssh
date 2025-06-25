// index.js
const axios   = require('axios')
const cheerio = require('cheerio')
const { Client } = require('ssh2')

let Service, Characteristic, UUID

module.exports = (api) => {
    Service        = api.hap.Service
    Characteristic = api.hap.Characteristic
    UUID           = api.hap.uuid

    api.registerPlatform(
        'homebridge-wol-ssh',   // package.json.name
        'WolSshPlatform',       // platform identifier
        WolSshPlatform,
        true                    // dynamic external accessories
    )
}

class WolSshPlatform {
    constructor(log, config, api) {
        this.log       = log
        this.config    = config
        this.api       = api
        this.accessories = []

        api.on('didFinishLaunching', () => this.publishSwitch())
    }

    configureAccessory(accessory) {
        this.accessories.push(accessory)
    }

    publishSwitch() {
        const uuid = UUID.generate(this.config.domain)
        const acc  = new this.api.platformAccessory(this.config.name, uuid)
        acc.category = this.api.hap.Categories.SWITCH

        const sw = acc.addService(Service.Switch, this.config.name)
        sw.getCharacteristic(Characteristic.On)
            .onGet(() => false)
            .onSet((value, cb) => this.handlePower(value, cb))

        this.api.publishExternalAccessories('homebridge-wol-ssh', [ acc ])
        this.log.info('✅ Published WOL-SSH Switch:', this.config.name)
    }

    async handlePower(on, callback) {
        if (on) {
            try {
                await this.doWake()
                this.log.info('WOL 실행 성공')
                callback()
            } catch (err) {
                this.log.error('WOL 오류', err.message)
                callback(err)
            }
        } else {
            const conn = new Client()
            conn.on('ready', () => {
                this.log.info('SSH 연결됨, 종료 명령 전송')
                conn.exec('shutdown /s /t 0', (err, stream) => {
                    if (err) {
                        this.log.error('SSH 오류', err)
                        conn.end()
                        return callback(err)
                    }
                    stream.on('close', () => {
                        this.log.info('SSH 종료 성공')
                        conn.end()
                        callback()
                    })
                })
            })
                .on('error', err => {
                    this.log.error('SSH 연결 실패', err)
                    callback(err)
                })
                .connect({
                    host:     this.config.domain.replace(/^https?:\/\//, ''),
                    port:     300,
                    username: 'sean',
                    // privateKey: require('fs').readFileSync('/home/homebridge/.ssh/id_rsa')
                })
        }
    }

    // 로그인 → 쿠키 파싱 → MAC 주소 파싱 → WOL 요청
    async doWake() {
        const { domain, username, password, targetName } = this.config

        // 1) 로그인 핸들러 호출
        const loginUrl  = `${domain}/sess-bin/login_handler.cgi`
        const sessionUrl= `${domain}/sess-bin/login_session.cgi?noauto=1`
        const loginBody = new URLSearchParams({
            username,
            passwd:         password,
            init_status:    1,
            captcha_on:     1,
            default_passwd: 'admin',
            Referer:        sessionUrl
        }).toString()

        const loginResp = await axios.post(loginUrl, loginBody, {
            headers: {
                'Connection':   'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        })

        // 2) document.cookie 스크립트에서 세션 쿠키 추출
        const cookieRe = /document\.cookie\s*=\s*'([^']+)'/g
        const cookies = []
        let m
        while (m = cookieRe.exec(loginResp.data)) cookies.push(m[1])
        if (!cookies.length) throw new Error('세션 쿠키 획득 실패')
        const sessionCookies = cookies.join('; ')
        this.log.debug('세션 쿠키:', sessionCookies)

        // 3) 목록 페이지에서 Desktop MAC 파싱
        const listUrl = `${domain}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`
        const listResp = await axios.get(listUrl, {
            headers: {
                'Connection':                'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Host':                      new URL(listUrl).host,
                'Cookie':                    sessionCookies
            }
        })
        const $ = cheerio.load(listResp.data)
        let macAddress = null
        $('tr.wol_main_tr').each((_, tr) => {
            const [mac, name] = $(tr).find('span.wol_main_span')
                .toArray().map(el => $(el).text().trim())
            if (name === targetName) macAddress = mac
        })
        if (!macAddress) throw new Error('MAC 주소 파싱 실패')
        this.log.debug('파싱된 MAC:', macAddress)

        // 4) Wake POST 요청
        const wakeUrl = `${domain}/sess-bin/timepro.cgi`
        const wakeBody = new URLSearchParams({
            tmenu:     'iframe',
            smenu:     'expertconfwollist',
            nomore:    '0',
            wakeupchk: macAddress,
            act:       'wake'
        }).toString()

        await axios.post(wakeUrl, wakeBody, {
            headers: {
                'Host':         new URL(wakeUrl).host,
                'Connection':   'keep-alive',
                'Cookie':       sessionCookies,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        })
    }
}
