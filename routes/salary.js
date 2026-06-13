/**
 * routes/salary.js — 급여 모듈 제거됨 (2026-06-13, 보안: 미사용 PII 모듈 완전 분리)
 *
 * 원본 급여 API 와 db-salary.js(컬럼명 SQL 인젝션 포함)는 더 이상 로드/마운트되지 않는다.
 * server.js 가 아직 이 파일을 require 하므로, 빈 라우터를 export 해 부팅만 유지하고
 * 어떤 급여 엔드포인트도 제공하지 않는다 (/api/salary/* → 매칭 없음 → 404).
 * 급여를 되살리려면 git 히스토리에서 이 파일(과 server.js 마운트)을 복원하면 된다.
 */
const express = require('express');
module.exports = express.Router();
