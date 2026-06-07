-- Workflow file storage rules
-- Purpose:
--   Document and seed company-specific folder rules used by workflow uploads.
--   Runtime code creates this table automatically when better-sqlite3 is available.

CREATE TABLE IF NOT EXISTS workflow_storage_rules (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_folder TEXT NOT NULL,
  company_aliases TEXT DEFAULT '[]',
  year_folder_template TEXT NOT NULL,
  project_folder_template TEXT DEFAULT '{project}',
  project_folder_mode TEXT DEFAULT 'under-year',
  priority INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 현대산업개발:
-- \\192.168.0.133\DD\★★현대산업개발\2026 시안작업\서울원 아이파크 (MXD)
INSERT OR IGNORE INTO workflow_storage_rules (
  id,
  company_name,
  company_folder,
  company_aliases,
  year_folder_template,
  project_folder_template,
  project_folder_mode,
  priority,
  active,
  note
) VALUES (
  'hyundai-development-2026',
  '현대산업개발',
  '★★현대산업개발',
  '["HDC","아이파크","현산"]',
  '{year} 시안작업',
  '{project}',
  'under-year',
  100,
  1,
  '현대산업개발 계열은 회사 폴더 아래 연도별 "{year} 시안작업" 폴더를 사용한다.'
);

-- 회사 추가 예시:
-- 1. company_name: 직원이 ERP에서 선택/입력하는 회사명
-- 2. company_folder: 실제 서버 D:\ 아래 회사 폴더명
-- 3. year_folder_template: "{year} 시안작업", "{year}년시안작업" 등 회사별 실제 연도 폴더 규칙
-- 4. project_folder_template: 보통 "{project}", 회사가 프로젝트 앞에 고정 접두어를 붙이면 여기에 반영
-- 5. priority: 같은 회사명이 애매하게 매칭될 때 높은 값 우선
