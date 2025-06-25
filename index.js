const axios   = require('axios');
const cheerio = require('cheerio');
const { Client } = require('ssh2');

let Service, Characteristic, UUID;

module.exports = (api) => {
    Service        = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    UUID           = api.hap.uuid;

    api.registerPlatform(
        'homebridge-wol-ssh',  // package.json.name
        'WolSshPlatform',      // platform identifier
        WolSshPlatform,
        true                   // dynamic external accessories
    );
};

class WolSshPlatform {
    constructor(log, config, api) {
        this.log    = log;
        this.config = config;
        this.api    = api;
        api.on('didFinishLaunching', () => this.publishSwitch());
    }

    publishSwitch() {
        const uuid = UUID.generate(this.config.domain);
        const acc  = new this.api.platformAccessory(this.config.name, uuid);
        acc.category = this.api.hap.Categories.SWITCH;

        const sw = acc.addService(Service.Switch, this.config.name);
        sw.getCharacteristic(Characteristic.On)
            .onGet(() => false)
            .onSet((v, cb) => this.handlePower(v, cb));

        this.api.publishExternalAccessories('homebridge-wol-ssh', [acc]);
        this.log.info('✅ Published WOL-SSH Switch:', this.config.name);
    }

    async handlePower(on, cb) {
        if (on) {
            try {
                await this.doWake();
                this.log.info('WOL 실행 성공');
                cb();
            } catch (e) {
                this.log.error('WOL 오류', e.message);
                cb(e);
            }
        } else {
            const conn = new Client();
            conn.on('ready', () => {
                this.log.info('SSH 연결됨, 종료 명령 전송');
                conn.exec('shutdown /s /t 0', (err, stream) => {
                    if (err) return cb(err);
                    stream.on('close', () => {
                        this.log.info('SSH 종료 성공');
                        conn.end();
                        cb();
                    });
                });
            })
                .on('error', err => cb(err))
                .connect({
                    host:     this.config.domain.replace(/^https?:\/\//, ''),
                    port:     22,
                    username: this.config.username,
                    password: this.config.password
                });
        }
    }

    async doWake() {
        const { domain, username, password, targetName } = this.config;

        // 1) 로그인 → 세션 쿠키
        const loginResp = await axios.post(
            `${domain}/sess-bin/login_handler.cgi`,
            new URLSearchParams({
                username, passwd: password,
                init_status:1, captcha_on:1, default_passwd:'admin',
                Referer: `${domain}/sess-bin/login_session.cgi?noauto=1`
            }).toString(),
            { headers: { 'Content-Type':'application/x-www-form-urlencoded' } }
        );

        const cookies = [...loginResp.data.matchAll(/document\.cookie\s*=\s*'([^']+)'/g)]
            .map(m => m[1]);
        if (!cookies.length) throw new Error('세션 쿠키 획득 실패');
        const sessionCookie = cookies.join('; ');

        // 2) 목록 조회 → MAC 파싱
        const listResp = await axios.get(
            `${domain}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`,
            { headers: { Cookie: sessionCookie } }
        );
        const $ = cheerio.load(listResp.data);
        const mac = $('tr.wol_main_tr').toArray()
            .map(tr => $(tr).find('span.wol_main_span').text().trim())
            .filter((_,i) => i % 2 === 0)
            .filter((_,idx) =>
                $('tr.wol_main_tr').eq(idx)
                    .find('span.wol_main_span').eq(1).text().trim() === targetName
            )[0];
        if (!mac) throw new Error('MAC 주소 파싱 실패');

        // 3) WOL 실행
        await axios.post(
            `${domain}/sess-bin/timepro.cgi`,
            new URLSearchParams({
                tmenu:'iframe',
                smenu:'expertconfwollist',
                nomore:'0',
                wakeupchk:mac,
                act:'wake'
            }).toString(),
            { headers:{ Cookie: sessionCookie, 'Content-Type':'application/x-www-form-urlencoded' } }
        );
    }
}
