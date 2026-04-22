# 서버 PC 동기화 가이드 (급여 탭 복구용)

## 왜 하는 거?
관리자 PC(192.168.0.30)의 salary-daemon 을 **3001 → 3002 포트**로 옮겼음.  
서버 PC(192.168.0.133)도 "급여 데몬은 3002에 있다"고 알려줘야 급여 탭이 정상 동작.

서버 PC에는 이 정보가 `proxy-watchdog.bat` / `서버_프록시모드_와치독.bat` / `서버_프록시모드실행.bat` 안에 `SALARY_DAEMON_URL=http://192.168.0.30:3002` 로 들어가야 함.

## 한 번만 세팅 (이후론 자동)
`.gitignore` 에 이 4개 파일만 예외로 등록해놨음:
- `proxy-watchdog.bat`
- `서버_프록시모드_와치독.bat`
- `서버_프록시모드실행.bat`
- `git-pull-server.bat`

이제부터는 관리자 PC에서 이 파일들을 수정하면, `git push` 해서 서버 PC에서 `git pull` 받으면 자동 동기화됨. 다음에 비슷한 작업 할 때도 USB/공유드라이브 필요 없음.

---

## 실행 절차 (2단계)

### 1단계: 관리자 PC 에서 푸시
[_배포_서버프록시bat.bat 실행](computer:///sessions/epic-peaceful-bohr/mnt/업체별%20단가표%20만들기!!!/price-list-app/_배포_서버프록시bat.bat)

- 관리자 권한 필요 없음
- 수정된 bat 파일 4개 + .gitignore + CLAUDE.md 를 GitHub 에 push

### 2단계: 서버 PC 에서 pull + 재시작
서버 PC(192.168.0.133) 에 가서:
1. `D:\price-list-app` 폴더 열기
2. `git-pull-server.bat` 더블클릭
3. "DONE! Server updated and restarted." 메시지 뜰 때까지 대기

## 완료 후 확인
ERP 접속 → 급여 탭 조회 → 정상 데이터 나와야 함  
(출퇴근은 이미 CAPS 브릿지 3001 로 복구된 상태라 무관)

## 문제 생기면
- 관리자 PC 에서 `netstat -ano | findstr :3002` → LISTENING 있는지 확인
  - 없으면 `_급여데몬_재기동.bat` 실행
- 서버 PC 에서 `netstat -ano | findstr :3000` → LISTENING 있는지 확인
  - 없으면 `D:\price-list-app\start-server.vbs` 더블클릭
