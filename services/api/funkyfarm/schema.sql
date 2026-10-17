-- Fresh-install migration. Run with the separate migration identity, never the API role.
CREATE SCHEMA IF NOT EXISTS funkyfarm;
SET search_path TO funkyfarm,public;

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE CHECK(email=lower(email)),
    password_hash text NOT NULL,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK(role IN ('owner','adviser','worker')),
    farm_ids uuid[],
    permissions text[] NOT NULL DEFAULT ARRAY['read','review'],
    invitation_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_attempts (
    bucket text PRIMARY KEY,
    window_started timestamptz NOT NULL,
    attempts integer NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
    revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
    data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS records_workspace_kind ON records(workspace_id,kind,updated_at DESC);
CREATE INDEX IF NOT EXISTS records_farm ON records(workspace_id,(data->>'farm_id'));
-- Only the narrow helper can reserve training workspaces. This is allocation
-- metadata, not farm data; the runtime receives no table privileges.
CREATE TABLE IF NOT EXISTS demo_workspace_reservations (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash text NOT NULL CHECK(length(key_hash)=64),
    fixture_id text NOT NULL,
    workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,key_hash)
);
CREATE TABLE IF NOT EXISTS record_history (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    record_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    kind text NOT NULL,
    data jsonb NOT NULL,
    actor_id uuid NOT NULL REFERENCES users(id),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(record_id,revision)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL DEFAULT current_setting('app.user_id')::uuid REFERENCES users(id),
    scope text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,user_id,scope,key)
);
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1,
    data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS public_content (
    id uuid PRIMARY KEY,
    author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK(kind IN ('question','reply','adviser_profile')),
    data jsonb NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden','withdrawn')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS community_reviewers (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);
-- Only public source metadata is global. Farm relevance/preferences stay in RLS records.
CREATE TABLE IF NOT EXISTS regulatory_source_state (
    source_id text PRIMARY KEY,
    url text NOT NULL,
    etag text,
    last_modified text,
    content_hash text,
    last_checked_at timestamptz,
    next_check_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    last_status text,
    last_http_status integer,
    failure_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS regulatory_next_check ON regulatory_source_state(next_check_at);
CREATE TABLE IF NOT EXISTS regulatory_source_events (
    id uuid PRIMARY KEY,
    source_id text NOT NULL,
    source_url text NOT NULL,
    detected_at timestamptz NOT NULL,
    previous_hash text NOT NULL,
    current_hash text NOT NULL,
    event_type text NOT NULL DEFAULT 'official_page_changed',
    UNIQUE(source_id,source_url,detected_at,current_hash)
);
CREATE INDEX IF NOT EXISTS regulatory_events_detected ON regulatory_source_events(detected_at DESC);
CREATE TABLE IF NOT EXISTS assistant_oauth_clients (
    client_id text PRIMARY KEY,
    metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS assistant_oauth_requests (
    id uuid PRIMARY KEY,
    browser_hash text NOT NULL,
    data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS community_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id uuid NOT NULL REFERENCES public_content(id) ON DELETE CASCADE,
    reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS community_reports_pending ON community_reports(created_at) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION has_membership() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT EXISTS(SELECT 1 FROM funkyfarm.memberships m
 WHERE m.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid)
$$;
CREATE OR REPLACE FUNCTION membership_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT md5(jsonb_build_object('workspace',m.workspace_id,'user',m.user_id,'role',m.role,
 'farm_ids',m.farm_ids,'permissions',m.permissions,'invitation',m.invitation_id,'created_at',m.created_at)::text)
 FROM funkyfarm.memberships m
 WHERE m.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid
$$;
CREATE OR REPLACE FUNCTION record_access(p_id uuid,p_kind text,p_data jsonb,p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT EXISTS(SELECT 1 FROM funkyfarm.memberships m
 WHERE m.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND (p_kind NOT IN ('ai_oauth_grants','ai_oauth_codes','ai_oauth_refresh','ai_credentials') OR m.role='owner')
 AND (p_kind<>'adviser_questions' OR m.role='owner' OR p_data->>'recipient_id'=m.user_id::text)
 AND (NOT p_write OR m.role='owner' OR 'review'=ANY(m.permissions))
 AND (NOT p_write OR nullif(current_setting('app.assistant_credential_id',true),'') IS NULL
   OR current_setting('app.assistant_can_propose',true)='true')
 AND (nullif(current_setting('app.assistant_farms',true),'') IS NULL OR
   (p_kind='farms' AND p_id::text IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('app.assistant_farms',true),''),'[]')::jsonb))) OR
   p_data->>'farm_id' IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('app.assistant_farms',true),''),'[]')::jsonb)))
 AND (m.farm_ids IS NULL OR
   (p_kind='farms' AND p_id=ANY(m.farm_ids)) OR
   (p_data->>'farm_id'=ANY(SELECT f::text FROM unnest(m.farm_ids) f))))
$$;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scoped_read ON records;
CREATE POLICY scoped_read ON records FOR SELECT USING (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND record_access(id,kind,data));
DROP POLICY IF EXISTS scoped_insert ON records;
CREATE POLICY scoped_insert ON records FOR INSERT WITH CHECK (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND record_access(id,kind,data,true));
DROP POLICY IF EXISTS scoped_update ON records;
CREATE POLICY scoped_update ON records FOR UPDATE USING (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND record_access(id,kind,data,true)) WITH CHECK (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND record_access(id,kind,data,true));
ALTER TABLE record_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scoped_history ON record_history;
CREATE POLICY scoped_history ON record_history FOR SELECT USING (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND record_access(record_id,kind,data));
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scoped_retries ON idempotency_keys;
CREATE POLICY scoped_retries ON idempotency_keys USING (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND user_id=nullif(current_setting('app.user_id',true),'')::uuid AND has_membership()) WITH CHECK (
 workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND user_id=nullif(current_setting('app.user_id',true),'')::uuid AND has_membership());
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_preferences ON user_preferences;
CREATE POLICY own_preferences ON user_preferences USING (user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
ALTER TABLE public_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_content FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_read ON public_content;
CREATE POLICY public_read ON public_content FOR SELECT USING (status='published' OR author_id=nullif(current_setting('app.user_id',true),'')::uuid);
DROP POLICY IF EXISTS own_public_insert ON public_content;
CREATE POLICY own_public_insert ON public_content FOR INSERT WITH CHECK(author_id=nullif(current_setting('app.user_id',true),'')::uuid AND status IN ('draft','published'));
DROP POLICY IF EXISTS own_public_update ON public_content;
CREATE POLICY own_public_update ON public_content FOR UPDATE USING(author_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(author_id=nullif(current_setting('app.user_id',true),'')::uuid AND status IN ('draft','published','withdrawn'));

CREATE OR REPLACE FUNCTION preserve_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'record identity and revision are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.kind='reports' AND OLD.data->>'status' IN ('issued','approved') THEN
   RAISE EXCEPTION 'issued report snapshots are immutable; record receipts separately' USING ERRCODE='23514';
  END IF;
  IF OLD.kind IN ('facts','operations','purchases','sales') AND OLD.data->>'review_status'='confirmed'
   AND (NEW.data-ARRAY['review_status','reviewed_by','reviewed_at','review_note','superseded_by'])
       IS DISTINCT FROM (OLD.data-ARRAY['review_status','reviewed_by','reviewed_at','review_note','superseded_by']) THEN
   RAISE EXCEPTION 'confirmed values are immutable; create a proposed correction' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.kind IN ('facts','operations','purchases','sales') AND NEW.data->>'review_status' IN ('confirmed','rejected') THEN
  IF NEW.data->>'reviewed_by' IS DISTINCT FROM current_setting('app.user_id') OR
   NOT EXISTS(SELECT 1 FROM funkyfarm.memberships WHERE workspace_id=NEW.workspace_id
    AND user_id=current_setting('app.user_id')::uuid AND role IN ('owner','adviser')
    AND (role='owner' OR 'review'=ANY(permissions))) THEN
   RAISE EXCEPTION 'an explicit authorized review actor is required' USING ERRCODE='42501';
  END IF;
 END IF;
 INSERT INTO funkyfarm.record_history(workspace_id,record_id,revision,kind,data,actor_id)
 VALUES(NEW.workspace_id,NEW.id,NEW.revision,NEW.kind,NEW.data,current_setting('app.user_id')::uuid);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS retain_record_revision ON records;
CREATE TRIGGER retain_record_revision AFTER INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION preserve_record();

CREATE OR REPLACE FUNCTION authentication_attempt(p_bucket text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE n integer;
BEGIN
 DELETE FROM funkyfarm.auth_attempts WHERE window_started<now()-interval '1 day';
 INSERT INTO funkyfarm.auth_attempts(bucket,window_started,attempts) VALUES(p_bucket,now(),1)
 ON CONFLICT(bucket) DO UPDATE SET
 attempts=CASE WHEN auth_attempts.window_started<now()-interval '15 minutes' THEN 1 ELSE auth_attempts.attempts+1 END,
 window_started=CASE WHEN auth_attempts.window_started<now()-interval '15 minutes' THEN now() ELSE auth_attempts.window_started END
 RETURNING attempts INTO n;
 RETURN n<=CASE WHEN left(p_bucket,8)='address:' THEN 120 ELSE 12 END;
END $$;
CREATE OR REPLACE FUNCTION register_user(p_email text,p_hash text,p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE u uuid; w uuid;
BEGIN
 INSERT INTO funkyfarm.users(email,password_hash,display_name) VALUES(lower(p_email),p_hash,p_name) RETURNING id INTO u;
 INSERT INTO funkyfarm.workspaces(name,owner_id) VALUES(p_name||'''s farm workspace',u) RETURNING id INTO w;
 INSERT INTO funkyfarm.memberships(workspace_id,user_id,role) VALUES(w,u,'owner');
 RETURN u;
END $$;
CREATE OR REPLACE FUNCTION login_identity(p_email text) RETURNS TABLE(id uuid,password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT u.id,u.password_hash FROM funkyfarm.users u WHERE u.email=lower(p_email)
$$;
CREATE OR REPLACE FUNCTION create_session(p_user uuid,p_hash text,p_csrf text,p_expires timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 INSERT INTO funkyfarm.sessions(token_hash,user_id,csrf_token,expires_at) VALUES(p_hash,p_user,p_csrf,p_expires)
$$;
CREATE OR REPLACE FUNCTION resolve_session(p_hash text,p_workspace uuid)
RETURNS TABLE(user_id uuid,workspace_id uuid,role text,csrf_token text,email text,display_name text,workspace_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT u.id,w.id,m.role,s.csrf_token,u.email,u.display_name,w.name
 FROM funkyfarm.sessions s JOIN funkyfarm.users u ON u.id=s.user_id
 JOIN funkyfarm.memberships m ON m.user_id=u.id JOIN funkyfarm.workspaces w ON w.id=m.workspace_id
 WHERE s.token_hash=p_hash AND s.revoked_at IS NULL AND s.expires_at>now()
 AND (p_workspace IS NULL OR w.id=p_workspace)
 ORDER BY (w.owner_id=u.id) DESC,w.created_at,w.id LIMIT 1
$$;
CREATE OR REPLACE FUNCTION revoke_session(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 UPDATE funkyfarm.sessions SET revoked_at=now() WHERE token_hash=p_hash
$$;
CREATE OR REPLACE FUNCTION workspace_list()
RETURNS TABLE(id uuid,name text,role text,farm_ids uuid[],permissions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT w.id,w.name,m.role,m.farm_ids,m.permissions FROM funkyfarm.memberships m
 JOIN funkyfarm.workspaces w ON w.id=m.workspace_id
 WHERE m.user_id=current_setting('app.user_id')::uuid ORDER BY w.created_at,w.id
$$;

CREATE OR REPLACE FUNCTION create_demo_workspace(p_fixture text,p_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE
 uid uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 source_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
 request_hash text; existing funkyfarm.demo_workspace_reservations; result uuid; retained integer;
BEGIN
 IF uid IS NULL OR p_fixture<>'lpis-correction-2026-v1'
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 16 AND 200 OR p_key !~ '^[!-~]+$'
  OR nullif(current_setting('app.assistant_credential_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM funkyfarm.memberships m JOIN funkyfarm.workspaces w ON w.id=m.workspace_id
    WHERE m.workspace_id=source_workspace AND m.user_id=uid AND m.role='owner' AND w.owner_id=uid) THEN
  RAISE EXCEPTION 'owner training workspace allocation required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(uid::text||':demo-workspace-allocation',0));
 request_hash:=encode(sha256(convert_to(p_key,'UTF8')),'hex');
 SELECT * INTO existing FROM funkyfarm.demo_workspace_reservations r WHERE r.user_id=uid AND r.key_hash=request_hash;
 IF FOUND THEN
  IF existing.fixture_id<>p_fixture THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  RETURN existing.workspace_id;
 END IF;
 SELECT count(*) INTO retained FROM funkyfarm.demo_workspace_reservations r WHERE r.user_id=uid;
 IF retained>=20 THEN RAISE EXCEPTION 'demo_workspace_limit' USING ERRCODE='P0001'; END IF;
 INSERT INTO funkyfarm.workspaces(name,owner_id)
 VALUES('FICTIONAL training farms '||(retained+1)::text,uid) RETURNING id INTO result;
 INSERT INTO funkyfarm.memberships(workspace_id,user_id,role) VALUES(result,uid,'owner');
 INSERT INTO funkyfarm.demo_workspace_reservations(user_id,key_hash,fixture_id,workspace_id)
 VALUES(uid,request_hash,p_fixture,result);
 -- FORCE RLS still applies to records; bind the new, actually owned workspace
 -- only for its single reservation record, then restore the caller's context.
 PERFORM set_config('app.workspace_id',result::text,true);
 INSERT INTO funkyfarm.records(id,workspace_id,kind,data)
 VALUES(gen_random_uuid(),result,'demo_runs',jsonb_build_object('status','reserved','fixture_id',p_fixture,
  'created_by',uid::text,'source_workspace_id',source_workspace::text,'request_key_hash',request_hash));
 PERFORM set_config('app.workspace_id',source_workspace::text,true);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION accept_invitation(p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE invite funkyfarm.records; uid uuid:=current_setting('app.user_id')::uuid; mail text; farms uuid[]; perms text[];
BEGIN
 SELECT email INTO mail FROM funkyfarm.users WHERE id=uid;
 SELECT * INTO invite FROM funkyfarm.records WHERE kind='invitations' AND data->>'token_hash'=p_hash AND deleted_at IS NULL FOR UPDATE;
 IF invite.id IS NULL OR lower(invite.data->>'email')<>mail OR invite.data->>'revoked_at' IS NOT NULL OR
 invite.data->>'accepted_at' IS NOT NULL OR (invite.data->>'expires_at')::timestamptz<=now() THEN
  RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='42501';
 END IF;
 IF invite.data->>'role' NOT IN ('adviser','worker') THEN RAISE EXCEPTION 'invalid invitation role' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(invite.data->'farm_ids')='array' THEN
  SELECT array_agg(value::uuid) INTO farms FROM jsonb_array_elements_text(invite.data->'farm_ids');
  IF farms IS NULL THEN farms:=ARRAY[]::uuid[]; END IF;
 END IF;
 SELECT array_agg(value) INTO perms FROM jsonb_array_elements_text(invite.data->'permissions');
 IF perms IS NULL OR NOT perms<@ARRAY['read','review']::text[] THEN RAISE EXCEPTION 'invalid permission scope' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM funkyfarm.memberships WHERE workspace_id=invite.workspace_id AND user_id=uid) THEN
  RAISE EXCEPTION 'revoke existing access before accepting a replacement invitation' USING ERRCODE='23505';
 END IF;
 INSERT INTO funkyfarm.memberships(workspace_id,user_id,role,farm_ids,permissions,invitation_id)
 VALUES(invite.workspace_id,uid,invite.data->>'role',farms,perms,invite.id);
 UPDATE funkyfarm.records SET data=data||jsonb_build_object('accepted_at',now(),'accepted_by',uid),revision=revision+1,updated_at=now() WHERE id=invite.id;
 RETURN invite.workspace_id;
END $$;
CREATE OR REPLACE FUNCTION revoke_invitation(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE invite funkyfarm.records; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM funkyfarm.memberships WHERE workspace_id=current_setting('app.workspace_id')::uuid AND user_id=current_setting('app.user_id')::uuid AND role='owner') THEN
  RAISE EXCEPTION 'owner role required' USING ERRCODE='42501';
 END IF;
 UPDATE funkyfarm.records SET data=data||jsonb_build_object('revoked_at',now()),revision=revision+1,updated_at=now()
 WHERE id=p_id AND kind='invitations' AND workspace_id=current_setting('app.workspace_id')::uuid RETURNING * INTO invite;
 IF invite.id IS NULL THEN RAISE EXCEPTION 'invitation unavailable' USING ERRCODE='42501'; END IF;
 DELETE FROM funkyfarm.memberships WHERE invitation_id=p_id AND role<>'owner';
 result:=to_jsonb(invite)-'deleted_at';
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION shared_report(p_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE share funkyfarm.records; report funkyfarm.records; mail text;
BEGIN
 SELECT email INTO mail FROM funkyfarm.users WHERE id=current_setting('app.user_id')::uuid;
 SELECT * INTO share FROM funkyfarm.records WHERE kind='shares' AND data->>'token_hash'=p_hash AND deleted_at IS NULL;
 IF share.id IS NULL OR share.data->>'revoked_at' IS NOT NULL OR (share.data->>'expires_at')::timestamptz<=now() OR lower(share.data->>'recipient_email')<>mail THEN
  RAISE EXCEPTION 'share unavailable' USING ERRCODE='42501';
 END IF;
 SELECT * INTO report FROM funkyfarm.records WHERE id=(share.data->>'report_id')::uuid AND workspace_id=share.workspace_id AND kind='reports' AND data->>'status'='issued' AND deleted_at IS NULL;
 IF report.id IS NULL THEN RAISE EXCEPTION 'issued report unavailable' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('share_id',share.id,'recipient_email',mail,'expires_at',share.data->>'expires_at','report',to_jsonb(report)-'deleted_at');
END $$;

CREATE OR REPLACE FUNCTION shared_selection(p_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE share funkyfarm.records; report funkyfarm.records; mail text;
 selected_documents jsonb; selected_count integer; requested_count integer;
BEGIN
 IF p_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT email INTO mail FROM funkyfarm.users WHERE id=nullif(current_setting('app.user_id',true),'')::uuid;
 IF mail IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO share FROM funkyfarm.records
 WHERE kind='shares' AND data->>'token_hash'=p_hash AND deleted_at IS NULL;
 IF share.id IS NULL OR share.data->>'revoked_at' IS NOT NULL
 OR coalesce((share.data->>'expires_at')::timestamptz<=now(),true)
 OR lower(share.data->>'recipient_email') IS DISTINCT FROM mail THEN RETURN NULL; END IF;
 IF jsonb_typeof(coalesce(share.data->'document_ids','[]'::jsonb))<>'array' THEN RETURN NULL; END IF;
 requested_count:=jsonb_array_length(coalesce(share.data->'document_ids','[]'::jsonb));
 IF requested_count>25 THEN RETURN NULL; END IF;
 IF share.data->>'report_id' IS NOT NULL THEN
  SELECT * INTO report FROM funkyfarm.records
  WHERE id=(share.data->>'report_id')::uuid AND workspace_id=share.workspace_id
  AND kind='reports' AND data->>'status'='issued' AND deleted_at IS NULL;
  IF report.id IS NULL THEN RETURN NULL; END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'filename',r.data->'filename',
  'media_type',r.data->'media_type','size_bytes',r.data->'size_bytes','sha256',r.data->'sha256') ORDER BY r.id),'[]'::jsonb),count(*)
 INTO selected_documents,selected_count FROM funkyfarm.records r
 WHERE r.workspace_id=share.workspace_id AND r.kind='documents' AND r.deleted_at IS NULL
 AND r.id::text IN (SELECT jsonb_array_elements_text(coalesce(share.data->'document_ids','[]'::jsonb)));
 IF selected_count<>requested_count OR (report.id IS NULL AND selected_count=0) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('share_id',share.id,'recipient_email',mail,'expires_at',share.data->>'expires_at',
  'report',CASE WHEN report.id IS NULL THEN NULL ELSE to_jsonb(report)-'deleted_at' END,'documents',selected_documents);
END $$;

CREATE OR REPLACE FUNCTION shared_document(p_hash text,p_document uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE selection jsonb; share funkyfarm.records; document funkyfarm.records;
BEGIN
 selection:=funkyfarm.shared_selection(p_hash);
 IF selection IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(selection->'documents') d
  WHERE d->>'id'=p_document::text) THEN RETURN NULL; END IF;
 SELECT * INTO share FROM funkyfarm.records WHERE id=(selection->>'share_id')::uuid AND kind='shares' AND deleted_at IS NULL;
 SELECT * INTO document FROM funkyfarm.records WHERE id=p_document AND workspace_id=share.workspace_id
  AND kind='documents' AND deleted_at IS NULL;
 IF document.id IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('share_id',share.id,'workspace_id',share.workspace_id,'document',to_jsonb(document)-'deleted_at');
END $$;

CREATE OR REPLACE FUNCTION resolve_assistant_token(p_hash text)
RETURNS TABLE(user_id uuid,workspace_id uuid,role text,credential_id uuid,farm_ids uuid[],permissions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT m.user_id,m.workspace_id,m.role,r.id,
  ARRAY(SELECT f::uuid FROM jsonb_array_elements_text(r.data->'farm_ids') f),
  ARRAY(SELECT permission FROM jsonb_array_elements_text(r.data->'permissions') permission)
 FROM funkyfarm.records r JOIN funkyfarm.memberships m
 ON m.workspace_id=r.workspace_id AND m.user_id=(r.data->>'created_by')::uuid
 WHERE r.kind='ai_credentials' AND r.deleted_at IS NULL AND r.data->>'token_hash'=p_hash
 AND m.role='owner' AND r.data->>'revoked_at' IS NULL
 AND coalesce((r.data->>'expires_at')::timestamptz>now(),false)
 AND jsonb_typeof(r.data->'farm_ids')='array' AND jsonb_array_length(r.data->'farm_ids') BETWEEN 1 AND 100
 AND (NOT (r.data ? 'oauth_grant_id') OR EXISTS(
  SELECT 1 FROM funkyfarm.records g WHERE g.id=(r.data->>'oauth_grant_id')::uuid
  AND g.workspace_id=r.workspace_id AND g.kind='ai_oauth_grants' AND g.deleted_at IS NULL
  AND g.data->>'created_by'=r.data->>'created_by' AND g.data->>'revoked_at' IS NULL
  AND (g.data->>'expires_at')::timestamptz>now()
  AND g.data->>'resource'=r.data->>'oauth_resource' AND g.data->>'issuer'=r.data->>'oauth_issuer'
  AND g.data->>'current_credential_id'=r.id::text
  AND g.data->>'grant_fingerprint'=r.data->>'grant_fingerprint'))
 AND r.data->>'grant_fingerprint'=md5(jsonb_build_object('workspace',m.workspace_id,'user',m.user_id,'role',m.role,
  'farm_ids',m.farm_ids,'permissions',m.permissions,'invitation',m.invitation_id,'created_at',m.created_at)::text)
$$;

CREATE OR REPLACE FUNCTION protect_public_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,funkyfarm AS $$
BEGIN
 IF current_user='funkyfarm_app' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.data ?| ARRAY['reviewed_by','reviewed_at','qualification_evidence','qualification_note','qualification_issuer','qualification_credential','qualification_expires_on','moderation_reason','moderated_by','moderated_at'] OR coalesce(NEW.data->>'qualification_status','unverified')<>'unverified' THEN
    RAISE EXCEPTION 'independent review required' USING ERRCODE='42501';
   END IF;
  ELSIF (NEW.data->'qualification_status',NEW.data->'reviewed_by',NEW.data->'reviewed_at',NEW.data->'qualification_evidence',NEW.data->'qualification_note',NEW.data->'qualification_issuer',NEW.data->'qualification_credential',NEW.data->'qualification_expires_on',NEW.data->'moderation_reason',NEW.data->'moderated_by',NEW.data->'moderated_at')
    IS DISTINCT FROM (OLD.data->'qualification_status',OLD.data->'reviewed_by',OLD.data->'reviewed_at',OLD.data->'qualification_evidence',OLD.data->'qualification_note',OLD.data->'qualification_issuer',OLD.data->'qualification_credential',OLD.data->'qualification_expires_on',OLD.data->'moderation_reason',OLD.data->'moderated_by',OLD.data->'moderated_at') THEN
    RAISE EXCEPTION 'independent review required' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.author_id<>OLD.author_id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at) THEN
   RAISE EXCEPTION 'published content identity is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='hidden' AND (NEW.status<>'withdrawn' OR NEW.data IS DISTINCT FROM OLD.data) THEN
   RAISE EXCEPTION 'hidden content may only be withdrawn by its author' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='withdrawn' AND NEW.status<>'withdrawn' THEN
   RAISE EXCEPTION 'withdrawn content cannot be republished' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_public_review_fields ON public_content;
CREATE TRIGGER protect_public_review_fields BEFORE INSERT OR UPDATE ON public_content FOR EACH ROW EXECUTE FUNCTION protect_public_review();
CREATE OR REPLACE FUNCTION moderate_public_content(p_id uuid,p_status text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE item funkyfarm.public_content; uid uuid:=current_setting('app.user_id')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM funkyfarm.community_reviewers WHERE user_id=uid) OR p_status NOT IN ('published','hidden') OR length(trim(p_reason))=0 THEN
  RAISE EXCEPTION 'independent moderator required' USING ERRCODE='42501';
 END IF;
 UPDATE funkyfarm.public_content SET status=p_status,data=data||jsonb_build_object('moderation_reason',p_reason,'moderated_by',uid,'moderated_at',now()),updated_at=now()
 WHERE id=p_id AND author_id<>uid AND status IN ('published','hidden') RETURNING * INTO item;
 IF item.id IS NULL THEN RAISE EXCEPTION 'content unavailable or self review' USING ERRCODE='42501'; END IF;
 UPDATE funkyfarm.community_reports SET resolved_at=now(),resolved_by=uid
 WHERE content_id=p_id AND resolved_at IS NULL;
 RETURN to_jsonb(item);
END $$;
CREATE OR REPLACE FUNCTION review_adviser_qualification(p_id uuid,p_decision text,p_evidence text,p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE item funkyfarm.public_content; uid uuid:=current_setting('app.user_id')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM funkyfarm.community_reviewers WHERE user_id=uid) OR p_decision NOT IN ('checked','rejected') OR length(trim(p_evidence))=0 THEN
  RAISE EXCEPTION 'independent qualification reviewer required' USING ERRCODE='42501';
 END IF;
 UPDATE funkyfarm.public_content SET data=data||jsonb_build_object('qualification_status',p_decision,'qualification_evidence',p_evidence,'qualification_note',p_note,'reviewed_by',uid,'reviewed_at',now()),updated_at=now()
 WHERE id=p_id AND kind='adviser_profile' AND author_id<>uid RETURNING * INTO item;
 IF item.id IS NULL THEN RAISE EXCEPTION 'profile unavailable or self review' USING ERRCODE='42501'; END IF;
 RETURN to_jsonb(item);
END $$;

-- The runtime receives no auth-table, membership-table, history-write, delete,
-- schema-create, owner, or bypass privileges. Functions are individually bounded.
CREATE OR REPLACE FUNCTION oauth_register_client(p_client_id text,p_metadata jsonb,p_expires timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
BEGIN
 IF length(p_client_id) NOT BETWEEN 20 AND 200 OR jsonb_typeof(p_metadata)<>'object'
  OR octet_length(p_metadata::text)>16000 OR p_expires<=clock_timestamp() OR p_expires>clock_timestamp()+interval '90 days' THEN
  RAISE EXCEPTION 'invalid client registration' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('funkyfarm:oauth-client-registration',0));
 DELETE FROM funkyfarm.assistant_oauth_clients WHERE expires_at<now()-interval '1 day';
 IF (SELECT count(*) FROM funkyfarm.assistant_oauth_clients)>=4096 THEN
  RAISE EXCEPTION 'client registration capacity reached' USING ERRCODE='23514';
 END IF;
 INSERT INTO funkyfarm.assistant_oauth_clients(client_id,metadata,expires_at) VALUES(p_client_id,p_metadata,p_expires);
 RETURN p_metadata||jsonb_build_object('client_id',p_client_id);
END $$;
CREATE OR REPLACE FUNCTION oauth_get_client(p_client_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT metadata||jsonb_build_object('client_id',client_id) FROM funkyfarm.assistant_oauth_clients
 WHERE client_id=p_client_id AND revoked_at IS NULL AND expires_at>now()
$$;
CREATE OR REPLACE FUNCTION oauth_create_request(p_id uuid,p_browser_hash text,p_data jsonb,p_expires timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
BEGIN
 IF length(p_browser_hash)<>64 OR jsonb_typeof(p_data)<>'object' OR octet_length(p_data::text)>16000
  OR p_expires<=now() OR p_expires>now()+interval '15 minutes' THEN
  RAISE EXCEPTION 'invalid authorization request' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('funkyfarm:oauth-browser-requests',0));
 DELETE FROM funkyfarm.assistant_oauth_requests WHERE expires_at<now()-interval '1 hour';
 IF (SELECT count(*) FROM funkyfarm.assistant_oauth_requests)>=4096 THEN
  RAISE EXCEPTION 'authorization request capacity reached' USING ERRCODE='23514';
 END IF;
 INSERT INTO funkyfarm.assistant_oauth_requests(id,browser_hash,data,expires_at) VALUES(p_id,p_browser_hash,p_data,p_expires);
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION oauth_get_request(p_id uuid,p_browser_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT data FROM funkyfarm.assistant_oauth_requests
 WHERE id=p_id AND browser_hash=p_browser_hash AND consumed_at IS NULL AND expires_at>now()
$$;
CREATE OR REPLACE FUNCTION oauth_consume_request(p_id uuid,p_browser_hash text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 UPDATE funkyfarm.assistant_oauth_requests SET consumed_at=now()
 WHERE id=p_id AND browser_hash=p_browser_hash AND consumed_at IS NULL AND expires_at>now() RETURNING data
$$;
CREATE OR REPLACE FUNCTION oauth_lookup_record(p_hash text,p_kind text)
RETURNS TABLE(id uuid,user_id uuid,workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT r.id,(r.data->>'created_by')::uuid,r.workspace_id FROM funkyfarm.records r
 WHERE length(p_hash)=64 AND p_kind IN ('ai_oauth_codes','ai_oauth_refresh','ai_credentials')
 AND r.kind=p_kind AND r.data->>'token_hash'=p_hash AND r.deleted_at IS NULL
 AND r.created_at>now()-interval '30 days'
 AND (p_kind<>'ai_credentials' OR r.data ? 'oauth_grant_id')
$$;
CREATE OR REPLACE FUNCTION adviser_recipients(p_farm uuid)
RETURNS TABLE(user_id uuid,display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
 SELECT m.user_id,u.display_name FROM funkyfarm.memberships actor
 JOIN funkyfarm.records f ON f.id=p_farm AND f.kind='farms' AND f.deleted_at IS NULL AND f.workspace_id=actor.workspace_id
 JOIN funkyfarm.memberships m ON m.workspace_id=actor.workspace_id AND m.role='adviser'
 JOIN funkyfarm.users u ON u.id=m.user_id
 WHERE actor.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
 AND actor.user_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND (actor.farm_ids IS NULL OR p_farm=ANY(actor.farm_ids))
 AND (actor.role='owner' OR (actor.role='adviser' AND actor.user_id=m.user_id))
 AND (m.farm_ids IS NULL OR p_farm=ANY(m.farm_ids))
 ORDER BY u.display_name,m.user_id LIMIT 100
$$;
CREATE OR REPLACE FUNCTION report_public_content(p_content uuid,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE uid uuid:=nullif(current_setting('app.user_id',true),'')::uuid; result uuid;
BEGIN
 IF uid IS NULL OR NOT funkyfarm.has_membership() OR length(trim(p_reason)) NOT BETWEEN 1 AND 2000
  OR NOT EXISTS(SELECT 1 FROM funkyfarm.public_content WHERE id=p_content AND status='published') THEN
  RAISE EXCEPTION 'published content and signed-in reporter required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(uid::text||':community-reports',0));
 SELECT id INTO result FROM funkyfarm.community_reports WHERE reporter_id=uid AND content_id=p_content AND created_at>now()-interval '1 day' LIMIT 1;
 IF result IS NOT NULL THEN RETURN result; END IF;
 IF (SELECT count(*) FROM funkyfarm.community_reports WHERE reporter_id=uid AND created_at>now()-interval '1 day')>=20 THEN
  RAISE EXCEPTION 'daily report limit reached' USING ERRCODE='23514';
 END IF;
 INSERT INTO funkyfarm.community_reports(content_id,reporter_id,reason) VALUES(p_content,uid,trim(p_reason)) RETURNING id INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION community_reports_queue(p_limit integer,p_offset integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE uid uuid:=nullif(current_setting('app.user_id',true),'')::uuid; items jsonb; total bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM funkyfarm.community_reviewers WHERE user_id=uid) THEN RETURN NULL; END IF;
 IF p_limit NOT BETWEEN 1 AND 50 OR p_offset<0 OR p_offset>100000 THEN
  RAISE EXCEPTION 'invalid moderation page' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO total FROM funkyfarm.community_reports r JOIN funkyfarm.public_content c ON c.id=r.content_id
 WHERE r.resolved_at IS NULL AND c.status IN ('published','hidden') AND c.author_id<>uid;
 SELECT coalesce(jsonb_agg(item),'[]'::jsonb) INTO items FROM (
  SELECT jsonb_build_object('id',r.id,'content_id',r.content_id,'reason',r.reason,'created_at',r.created_at,'content',to_jsonb(c)) AS item
  FROM funkyfarm.community_reports r JOIN funkyfarm.public_content c ON c.id=r.content_id
  WHERE r.resolved_at IS NULL AND c.status IN ('published','hidden') AND c.author_id<>uid
  ORDER BY r.created_at,r.id LIMIT p_limit OFFSET p_offset) page;
 RETURN jsonb_build_object('items',items,'total',total,'limit',p_limit,'offset',p_offset);
END $$;
CREATE OR REPLACE FUNCTION review_adviser_qualification(p_id uuid,p_decision text,p_evidence text,p_note text,p_issuer text,p_credential text,p_expires date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,funkyfarm AS $$
DECLARE item funkyfarm.public_content; uid uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM funkyfarm.community_reviewers WHERE user_id=uid) OR p_decision NOT IN ('checked','rejected')
  OR length(trim(p_evidence)) NOT BETWEEN 1 AND 4000 OR length(trim(p_issuer)) NOT BETWEEN 1 AND 300
  OR length(trim(p_credential)) NOT BETWEEN 1 AND 300 OR length(p_note)>4000
  OR (p_decision='checked' AND p_expires IS NOT NULL AND p_expires<current_date) THEN
  RAISE EXCEPTION 'independent current qualification evidence required' USING ERRCODE='42501';
 END IF;
 UPDATE funkyfarm.public_content SET data=data||jsonb_build_object('qualification_status',p_decision,
  'qualification_evidence',p_evidence,'qualification_note',p_note,'qualification_issuer',p_issuer,
  'qualification_credential',p_credential,'qualification_expires_on',p_expires,'reviewed_by',uid,'reviewed_at',now()),updated_at=now()
 WHERE id=p_id AND kind='adviser_profile' AND author_id<>uid RETURNING * INTO item;
 IF item.id IS NULL THEN RAISE EXCEPTION 'profile unavailable or self review' USING ERRCODE='42501'; END IF;
 RETURN to_jsonb(item);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA funkyfarm FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA funkyfarm FROM PUBLIC;
REVOKE ALL ON SCHEMA funkyfarm FROM PUBLIC;
GRANT USAGE ON SCHEMA funkyfarm TO funkyfarm_app;
GRANT SELECT,INSERT,UPDATE ON records TO funkyfarm_app;
GRANT SELECT ON record_history TO funkyfarm_app;
GRANT SELECT,INSERT ON idempotency_keys TO funkyfarm_app;
GRANT SELECT,INSERT,UPDATE ON user_preferences,public_content TO funkyfarm_app;
GRANT SELECT,INSERT,UPDATE ON regulatory_source_state TO funkyfarm_app;
GRANT SELECT,INSERT ON regulatory_source_events TO funkyfarm_app;
GRANT EXECUTE ON FUNCTION create_demo_workspace(text,text) TO funkyfarm_app;
GRANT EXECUTE ON FUNCTION oauth_register_client(text,jsonb,timestamptz),oauth_get_client(text),oauth_create_request(uuid,text,jsonb,timestamptz),oauth_get_request(uuid,text),oauth_consume_request(uuid,text),oauth_lookup_record(text,text),adviser_recipients(uuid),report_public_content(uuid,text),community_reports_queue(integer,integer),review_adviser_qualification(uuid,text,text,text,text,text,date) TO funkyfarm_app;
GRANT EXECUTE ON FUNCTION has_membership(),membership_fingerprint(),record_access(uuid,text,jsonb,boolean),authentication_attempt(text),register_user(text,text,text),login_identity(text),create_session(uuid,text,text,timestamptz),resolve_session(text,uuid),resolve_assistant_token(text),revoke_session(text),workspace_list(),accept_invitation(text),revoke_invitation(uuid),shared_report(text),shared_selection(text),shared_document(text,uuid),moderate_public_content(uuid,text,text),review_adviser_qualification(uuid,text,text,text) TO funkyfarm_app;
