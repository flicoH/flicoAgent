CREATE TABLE IF NOT EXISTS flico_rag_documents (
  collection VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doc_id VARCHAR(512) NOT NULL,
  body LONGTEXT NOT NULL,
  PRIMARY KEY (collection, doc_id),
  CHECK (CHAR_LENGTH(TRIM(doc_id)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS flico_rag_namespaces (
  namespace_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flico_rag_chunks (
  namespace_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doc_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chunk_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  doc_id VARCHAR(1024) NOT NULL,
  chunk_id VARCHAR(4096) NOT NULL,
  content LONGTEXT NOT NULL,
  embedding JSON NOT NULL,
  metadata JSON,
  PRIMARY KEY (namespace_key, chunk_key),
  KEY flico_rag_source_doc (namespace_key, source_key, doc_key),
  FOREIGN KEY (namespace_key) REFERENCES flico_rag_namespaces (namespace_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
