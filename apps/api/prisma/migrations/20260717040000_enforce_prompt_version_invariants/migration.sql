ALTER TABLE "PromptGenerationJob"
  ADD COLUMN "requestMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "PromptGenerationJob_request_metadata_check" CHECK (
    jsonb_typeof("requestMetadata") = 'object'
    AND pg_column_size("requestMetadata") <= 512
    AND ("requestMetadata" - 'destination') = '{}'::jsonb
    AND (
      NOT ("requestMetadata" ? 'destination')
      OR "requestMetadata"->>'destination' IN ('codex', 'chatgpt', 'claude', 'gemini', 'cursor', 'lovable', 'bolt')
    )
  );

CREATE FUNCTION "reject_prompt_version_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'prompt versions are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'PromptVersion_append_only_check';
END;
$$;

CREATE TRIGGER "PromptVersion_append_only_check"
BEFORE UPDATE OR DELETE ON "PromptVersion"
FOR EACH ROW
EXECUTE FUNCTION "reject_prompt_version_mutation"();

CREATE FUNCTION "enforce_prompt_version_source_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE source_project_id TEXT;
BEGIN
  IF NEW."sourceVersionId" IS NULL THEN RETURN NEW; END IF;
  SELECT "projectId" INTO source_project_id
    FROM "PromptVersion" WHERE "id" = NEW."sourceVersionId" FOR KEY SHARE;
  IF source_project_id IS DISTINCT FROM NEW."projectId" THEN
    RAISE EXCEPTION 'prompt version source must belong to the same project'
      USING ERRCODE = '23514', CONSTRAINT = 'PromptVersion_source_scope_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PromptVersion_source_scope_check"
BEFORE INSERT ON "PromptVersion"
FOR EACH ROW
EXECUTE FUNCTION "enforce_prompt_version_source_scope"();

CREATE FUNCTION "enforce_prompt_project_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE extraction_owner_id TEXT;
DECLARE version_project_id TEXT;
BEGIN
  SELECT "ownerId" INTO extraction_owner_id
    FROM "ExtractionJob" WHERE "id" = NEW."extractionId" FOR KEY SHARE;
  IF extraction_owner_id IS DISTINCT FROM NEW."ownerId" THEN
    RAISE EXCEPTION 'prompt project extraction scope is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'PromptProject_extraction_scope_check';
  END IF;
  IF NEW."currentVersionId" IS NOT NULL THEN
    SELECT "projectId" INTO version_project_id
      FROM "PromptVersion" WHERE "id" = NEW."currentVersionId" FOR KEY SHARE;
    IF version_project_id IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'current prompt version must belong to its project'
        USING ERRCODE = '23514', CONSTRAINT = 'PromptProject_current_version_scope_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PromptProject_current_version_scope_check"
AFTER INSERT OR UPDATE OF "currentVersionId", "ownerId", "extractionId" ON "PromptProject"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_prompt_project_scope"();

CREATE FUNCTION "enforce_prompt_job_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE project_owner_id TEXT;
DECLARE reference_project_id TEXT;
DECLARE connection_owner_id TEXT;
DECLARE connection_provider "LlmProvider";
DECLARE connection_mode "CredentialMode";
DECLARE connection_state "ConnectionState";
BEGIN
  SELECT "ownerId" INTO project_owner_id
    FROM "PromptProject" WHERE "id" = NEW."projectId" FOR KEY SHARE;
  IF project_owner_id IS DISTINCT FROM NEW."ownerId" THEN
    RAISE EXCEPTION 'prompt job owner scope is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'PromptGenerationJob_owner_scope_check';
  END IF;
  IF NEW."sourcePromptVersionId" IS NOT NULL THEN
    SELECT "projectId" INTO reference_project_id
      FROM "PromptVersion" WHERE "id" = NEW."sourcePromptVersionId" FOR KEY SHARE;
    IF reference_project_id IS DISTINCT FROM NEW."projectId" THEN
      RAISE EXCEPTION 'prompt job source must belong to its project'
        USING ERRCODE = '23514', CONSTRAINT = 'PromptGenerationJob_source_scope_check';
    END IF;
  END IF;
  IF NEW."resultPromptVersionId" IS NOT NULL THEN
    SELECT "projectId" INTO reference_project_id
      FROM "PromptVersion" WHERE "id" = NEW."resultPromptVersionId" FOR KEY SHARE;
    IF reference_project_id IS DISTINCT FROM NEW."projectId" THEN
      RAISE EXCEPTION 'prompt job result must belong to its project'
        USING ERRCODE = '23514', CONSTRAINT = 'PromptGenerationJob_result_scope_check';
    END IF;
  END IF;
  IF NEW."credentialMode" = 'PLATFORM_CREDITS'::"CredentialMode" AND NEW."connectionId" IS NOT NULL THEN
    RAISE EXCEPTION 'platform credits cannot reference a user connection'
      USING ERRCODE = '23514', CONSTRAINT = 'PromptGenerationJob_connection_scope_check';
  END IF;
  IF NEW."credentialMode" <> 'PLATFORM_CREDITS'::"CredentialMode" THEN
    SELECT "ownerId", "provider", "credentialMode", "state"
      INTO connection_owner_id, connection_provider, connection_mode, connection_state
      FROM "AiConnection" WHERE "id" = NEW."connectionId" FOR KEY SHARE;
    IF connection_owner_id IS DISTINCT FROM NEW."ownerId"
      OR connection_provider IS DISTINCT FROM NEW."provider"
      OR connection_mode IS DISTINCT FROM NEW."credentialMode"
      OR connection_state IS DISTINCT FROM 'ACTIVE'::"ConnectionState"
    THEN
      RAISE EXCEPTION 'prompt job connection scope is invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'PromptGenerationJob_connection_scope_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PromptGenerationJob_source_scope_check"
AFTER INSERT OR UPDATE OF "ownerId", "projectId", "provider", "credentialMode", "connectionId", "sourcePromptVersionId", "resultPromptVersionId"
ON "PromptGenerationJob"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_prompt_job_scope"();
