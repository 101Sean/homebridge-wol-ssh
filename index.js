const { Client } = require('ssh2');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');
const { URL } = require('url');

let Service, Characteristic, UUID, Categories;

module.exports = api => {
    Service        = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    UUID           = api.hap.uuid;
    Categories     = api.hap.Categories;

    api.registerPlatform('homebridge-wol-ssh', 'WolSshPlatform', WolSshPlatform, true);
};

class WolSshPlatform {
    constructor(log, config, api) {
        this.log      = log;
        this.config   = config;
        this.api      = api;
        this.sshUser  = config.sshUsername || config.username;

        api.on('didFinishLaunching', () => this.publishTVAccessory());
    }

    publishTVAccessory() {
        const uuid = UUID.generate(this.config.domain);
        const acc  = new this.api.platformAccessory(this.config.name, uuid);

        acc.category = Categories.TELEVISION;

        const tvService = acc.addService(Service.Television, this.config.name);

        tvService.setCharacteristic(Characteristic.ConfiguredName, this.config.name);
        tvService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

        tvService.getCharacteristic(Characteristic.Active)
            .onGet(() => Characteristic.Active.INACTIVE)
            .onSet(async (value) => {
                if (value === Characteristic.Active.ACTIVE) {
                    this.log.info('[Power] PC 켜기 명령 실행 (WOL)');
                    await this._powerOn();
                } else {
                    this.log.info('[Power] PC 끄기 명령 실행 (SSH)');
                    await this._powerOff();
                }

                setTimeout(() => {
                    tvService.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
                }, 5000);
            });

        this.api.publishExternalAccessories('homebridge-wol-ssh', [acc]);
        this.log.info('✅ PC TV 액세서리 게시 완료:', this.config.name);
    }

    async _powerOn() {
        try {
            await this.doWake();
            this.log.info('[WOL] 매직 패킷 전송 완료');
        } catch (err) {
            this.log.error('[WOL] 오류 발생:', err.message);
        }
    }

    _powerOff() {
        const urlData = new URL(this.config.domain);
        const hostname = urlData.hostname;
        const port = this.config.sshPort || 22;

        return new Promise((resolve, reject) => {
            const conn = new Client();
            conn.on('ready', () => {
                conn.exec('shutdown /s /t 0', (err, stream) => {
                    if (err) return reject(err);
                    stream.on('close', () => {
                        this.log.info('[SSH] 종료 명령 성공');
                        conn.end();
                        resolve();
                    });
                });
            })
                .on('error', (err) => {
                    this.log.error('[SSH] 연결 오류:', err.message);
                    reject(err);
                })
                .connect({
                    host: hostname,
                    port,
                    username: this.sshUser,
                    password: this.config.password
                });
        });
    }

    httpRequest(options, body = '') {
        options.insecureHTTPParser = true;
        const lib = options.protocol === 'https:' ? https : http;
        options.agent = new lib.Agent({ allowInsecureHTTPParser: true });

        return new Promise((resolve, reject) => {
            const req = lib.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', err => reject(err));
            if (body) req.write(body);
            req.end();
        });
    }

    async doWake() {
        const { domain, wolPort, username, password, targetName } = this.config;
        const url = new URL(domain);
        url.port = wolPort;
        const origin = url.origin;

        // 1) 로그인
        const loginPath = `${url.pathname}/sess-bin/login_handler.cgi`;
        const loginBody = new URLSearchParams({
            username, passwd: password, init_status: 1, captcha_on: 1, default_passwd: 'admin'
        }).toString();

        const loginResp = await this.httpRequest({
            protocol: url.protocol, hostname: url.hostname, port: url.port,
            method: 'POST', path: loginPath,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, loginBody);

        const match = loginResp.body.match(/setCookie\('([^']+)'\)/);
        if (!match) throw new Error('세션 쿠키 파싱 실패');
        const sessionId = match[1].trim();

        // 2) MAC 목록 조회 및 파싱
        const listPath = `${url.pathname}/sess-bin/timepro.cgi?tmenu=iframe&smenu=expertconfwollist`;
        const listResp = await this.httpRequest({
            protocol: url.protocol, hostname: url.hostname, port: url.port,
            method: 'GET', path: listPath,
            headers: { Cookie: `efm_session_id=${sessionId}` }
        });

        const $ = cheerio.load(listResp.body);
        let mac = null;
        $('tr.wol_main_tr').each((_, tr) => {
            const desc = $(tr).find('td').eq(2).find('.wol_main_span').text().trim();
            if (desc === targetName) {
                mac = $(tr).find('input[name="wakeupchk"]').attr('value');
                return false;
            }
        });

        if (!mac) throw new Error(`MAC 파싱 실패: ${targetName}`);

        // 3) WOL POST
        const wakePath = `${url.pathname}/sess-bin/timepro.cgi`;
        const wakeBody = new URLSearchParams({ tmenu: 'iframe', smenu: 'expertconfwollist', wakeupchk: mac, act: 'wake' }).toString();

        await this.httpRequest({
            protocol: url.protocol, hostname: url.hostname, port: url.port,
            method: 'POST', path: wakePath,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `efm_session_id=${sessionId}` }
        }, wakeBody);
    }
}