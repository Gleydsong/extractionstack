INSERT INTO "User" ("id", "auth0Sub", "role", "updatedAt")
VALUES ('upgrade-user', 'auth0|upgrade-user', 'USER', CURRENT_TIMESTAMP);

INSERT INTO "ExtractionJob" (
  "id", "ownerId", "requestedUrl", "normalizedUrl", "idempotencyKey", "status", "finishedAt", "updatedAt"
) VALUES (
  'upgrade-extraction', 'upgrade-user', 'https://example.test', 'https://example.test/',
  'upgrade-extraction-key', 'SUCCEEDED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "PromptProject" (
  "id", "ownerId", "extractionId", "title", "category", "language", "wizardInput", "updatedAt"
) VALUES (
  'upgrade-project', 'upgrade-user', 'upgrade-extraction', 'Upgrade fixture', 'application',
  'en-US', '{}'::jsonb, CURRENT_TIMESTAMP
);

INSERT INTO "PromptGenerationJob" (
  "id", "ownerId", "projectId", "operation", "provider", "model", "credentialMode",
  "idempotencyKey", "status", "startedAt", "finishedAt", "providerCompletedAt", "updatedAt"
) VALUES
  (
    'upgrade-succeeded', 'upgrade-user', 'upgrade-project', 'GENERATE', 'FAKE', 'fake-v1',
    'PLATFORM_CREDITS', 'upgrade-succeeded-key', 'SUCCEEDED', CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
  ),
  (
    'upgrade-ambiguous-completed', 'upgrade-user', 'upgrade-project', 'GENERATE', 'FAKE',
    'fake-v1', 'PLATFORM_CREDITS', 'upgrade-ambiguous-completed-key', 'AMBIGUOUS',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'upgrade-ambiguous-started', 'upgrade-user', 'upgrade-project', 'GENERATE', 'FAKE',
    'fake-v1', 'PLATFORM_CREDITS', 'upgrade-ambiguous-started-key', 'AMBIGUOUS',
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
  );

INSERT INTO "CreditLedgerEntry" (
  "id", "ownerId", "jobId", "kind", "amountMinor", "currency", "idempotencyKey", "metadata"
) VALUES (
  'upgrade-standalone-adjustment', 'upgrade-user', NULL, 'ADJUSTMENT', 25, 'CREDITS',
  'upgrade-standalone-adjustment-key', '{"reason":"historical manual adjustment"}'::jsonb
);
