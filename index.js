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
        'WolSshPlatform',       // 플랫폼 식별자
        WolSshPlatform,
        true                    // 동적 외부 액세서리 모드
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

        // onSet에는 callback 대신 프로미스 반환 방식 사용
        sw.getCharacteristic(Characteristic.On)
            .onGet(() => false)
            .onSet(async (value) => {
                await this.handlePower(value)
            })

        this.api.publishExternalAccessories('homebridge-wol-ssh', [ acc ])
        this.log.info('✅ Published WOL-SSH Switch:', this.config.name)
    }

    async handlePower(on) {
        if (on) {
            // Wake-on-LAN
            try {
                await this.doWake()
                this.log.info('WOL 실행 성공')
            } catch (e) {
                this.log.error('WOL 오류', e.message)
                throw e
            }
        } else {
            // SSH를 통한 원격 종료
            return new Promise((resolve, reject) => {
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
                        host:     this.config.domain.replace(/^http?:\/\//, ''),
                        port:     this.config.port,
                        username: this.config.username,
                        password: this.config.password,
                        // 또는 privateKey: require('fs').readFileSync('~/.ssh/id_rsa')
                    })
            })
        }
    }

    async doWake() {
        const { domain, username, password, targetName } = this.config
        const url = new URL(domain)
        const host = domain.replace(/^http?:\/\//, '')

        // 1) 로그인 → 세션 쿠키 파싱
        const loginResp = await axios.post(
            `${url.origin}/sess-bin/login_handler.cgi`,
            new URLSearchParams({
                username: username, passwd: password,
                init_status:1, captcha_on:1, default_passwd:'admin',
                Referer: `${url.origin}/sess-bin/login_session.cgi?noauto=1`
            }).toString(),
            {
                headers: {
                    'Connection':'keep-alive'
                }
            }
        )

        const cookies = [...loginResp.data.matchAll(/document\.cookie\s*=\s*'([^']+)'/g)]
            .map(m=>m[1])
        if (!cookies.length) throw new Error('세션 쿠키 획득 실패')
        const sessionCookie = cookies.join('; ')

        // 2) MAC 목록 GET → 파싱
        const listResp = await axios.get(
            `${url.origin}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`,
            {
                headers: {
                    'Connection':'keep-alive',
                    'Upgrade-Insecure-Requests':1,
                    'Host': host,
                    'Cookie': 'efm_session_id=' + sessionCookie
                }
            }
        )
        const $ = cheerio.load(listResp.data)
        const mac = $('tr.wol_main_tr').toArray()
            .map(tr=>$(tr).find('span.wol_main_span').text().trim())
            .filter((_,i)=>i%2===0)
            .filter((_,idx)=>$('tr.wol_main_tr').eq(idx)
                .find('span.wol_main_span').eq(1).text().trim()===targetName
            )[0]
        if (!mac) throw new Error('MAC 주소 파싱 실패')

        // 3) WOL POST
        await axios.post(
            `${url.origin}/sess-bin/timepro.cgi`,
            new URLSearchParams({
                tmenu:'iframe', smenu:'expertconfwollist',
                nomore:0, wakeupchk:mac, act:'wake'
            }).toString(),
            {
                headers:{
                    'Host': host,
                    'Cookie': 'efm_session_id=' + sessionCookie
                }
            }
        )
    }
}
