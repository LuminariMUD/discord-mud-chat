CREATE TABLE IF NOT EXISTS discord_news_delivery (
    sequence_no BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    destination VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title TEXT NOT NULL,
    body MEDIUMTEXT NOT NULL,
    parts JSON NOT NULL,
    message_ids JSON NOT NULL DEFAULT ('[]'),
    state ENUM('queued', 'sending', 'delivered', 'retryable', 'needs_review') NOT NULL DEFAULT 'queued',
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    retry_at DATETIME(3) NULL,
    failure VARCHAR(80) NULL,
    PRIMARY KEY (sequence_no),
    UNIQUE KEY (id),
    KEY (destination, sequence_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
