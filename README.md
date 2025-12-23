## Homebridge WOL-SSH
#### Homebridge 에서 사용할, Desktop 원격 전원 스위치
#### WOL 
* iptime 웹 인터페이스 직접 조작
* 로그인 > 세션ID 파싱 > MAC 조회/파싱 > WOL 요청 흐름
#### SSH
* ssh 접속으로 shutdown 명령어 동작
---
#### v1.0
* 기본 동작 구현 (ssh2, cheerio, http)
* Switch 악세서리 사용
#### v1.1
* 비주얼 업데이트 (악세서리 타일 Switch > TV)
