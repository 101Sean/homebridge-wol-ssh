const axios   = require('axios')
const cheerio = require('cheerio')
const { Client } = require('ssh2')

let Service, Characteristic

module.exports = (api) => {
    Service = api.hap.Service
    Characteristic = api.hap.Characteristic
    api.registerAccessory('MyTvPowerSwitch', MyTvPowerSwitch)
}

class MyTvPowerSwitch {
    constructor(log, config) {
        this.log    = log
        this.config = config

        const { domain } = config
        this.loginUrl   = `${domain}/sess-bin/login_handler.cgi`
        this.sessionUrl = `${domain}/sess-bin/login_session.cgi?noauto=1`
        this.listUrl    = `${domain}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`
        this.wakeUrl    = `${domain}/sess-bin/timepro.cgi`

        this.informationService = new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, 'Custom')
            .setCharacteristic(Characteristic.Model,        'TV–WOL+SSH')

        this.switchService = new Service.Switch(config.name || 'TV Power')
        this.switchService.getCharacteristic(Characteristic.On)
            .on('get', this.handleGet.bind(this))
            .on('set', this.handleSet.bind(this))
    }

    getServices() {
        return [ this.informationService, this.switchService ]
    }

    handleGet(cb) {
        cb(null, false)
    }

    async handleSet(on, cb) {
        if (!on) {
            // OFF: SSH로 원격 종료
            const conn = new Client()
            conn.on('ready', () => {
                this.log('SSH 연결됨, 종료 명령 전송')
                conn.exec('shutdown /s /t 0', (err, stream) => {
                    if (err) {
                        this.log.error(err)
                        conn.end()
                        return cb(err)
                    }
                    stream.on('close', () => {
                        this.log('종료 명령 완료')
                        conn.end()
                        cb(null)
                    })
                })
            })
                .on('error', err => {
                    this.log.error('SSH 연결 실패', err)
                    cb(err)
                })
                .connect({
                    host:     this.config.domain.replace(/^https?:\/\//, ''),
                    port:     300,
                    username: 'sean',
                    // privateKey 옵션 필요 시 uncomment
                    // privateKey: require('fs').readFileSync('/home/homebridge/.ssh/id_rsa')
                })
            return
        }

        try {
            // ON: 로그인 → 쿠키 → MAC 파싱 → WOL
            const loginBody = new URLSearchParams({
                username:       this.config.username,
                passwd:         this.config.password,
                init_status:    1,
                captcha_on:     1,
                default_passwd: 'admin',
                Referer:        this.sessionUrl
            }).toString()

            const loginResp = await axios.post(this.loginUrl, loginBody, {
                headers: {
                    'Connection':   'keep-alive',
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            })

            const cookieRe = /document\.cookie\s*=\s*'([^']+)'/g
            const cookies = []
            let m
            while (m = cookieRe.exec(loginResp.data)) cookies.push(m[1])
            if (!cookies.length) throw new Error('세션 쿠키 획득 실패')
            this.sessionCookies = cookies.join('; ')
            this.log('세션 쿠키:', this.sessionCookies)

            const listResp = await axios.get(this.listUrl, {
                headers: {
                    'Connection':                'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Host':                      new URL(this.listUrl).host,
                    'Cookie':                    this.sessionCookies
                }
            })

            const $ = cheerio.load(listResp.data)
            $('tr.wol_main_tr').each((_, tr) => {
                const [mac, name] = $(tr).find('span.wol_main_span')
                    .toArray().map(el => $(el).text().trim())
                if (name === this.config.targetName) {
                    this.macAddress = mac
                    this.log('MAC 파싱:', mac)
                }
            })
            if (!this.macAddress) throw new Error('MAC 주소 파싱 실패')

            const wakeBody = new URLSearchParams({
                tmenu:     'iframe',
                smenu:     'expertconfwollist',
                nomore:    '0',
                wakeupchk: this.macAddress,
                act:       'wake'
            }).toString()

            await axios.post(this.wakeUrl, wakeBody, {
                headers: {
                    'Host':         new URL(this.wakeUrl).host,
                    'Connection':   'keep-alive',
                    'Cookie':       this.sessionCookies,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            })
            this.log('WOL 실행 성공')
            cb(null)
        } catch (e) {
            this.log.error('ON 오류:', e.message)
            cb(e)
        }
    }
}