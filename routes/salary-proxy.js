/**
 * routes/salary-proxy.js — 급여 프록시 제거됨 (2026-06-13, 보안: 미사용 PII 모듈 완전 분리)
 *
 * 급여 데몬(salary-daemon) 프록시는 더 이상 사용하지 않는다. server.js 가 SALARY_MODE=proxy 일 때
 * 이 파일을 require 하므로, 빈 라우터를 export 해 부팅만 유지한다 (/api/salary/* → 404).
 */
const express = require('express');
module.exports = express.Router();
