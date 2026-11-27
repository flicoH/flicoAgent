CREATE TABLE IF NOT EXISTS flico_ai_traces (
  namespace_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  agent VARCHAR(128) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload LONGTEXT NOT NULL,
  PRIMARY KEY (namespace_key, run_id),
  KEY flico_ai_traces_scope_created (namespace_key, scope_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS flico_ai_memory (
  namespace_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thread_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thread_id VARCHAR(256) NOT NULL,
  updated_at BIGINT NOT NULL,
  payload LONGTEXT NOT NULL,
  PRIMARY KEY (namespace_key, thread_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS flico_ai_nonces (
  namespace_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (namespace_key, nonce_key),
  KEY flico_ai_nonces_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
