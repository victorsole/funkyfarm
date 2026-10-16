SELECT json_build_object(
  'users', (SELECT count(*) FROM funkyfarm.users),
  'workspaces', (SELECT count(*) FROM funkyfarm.workspaces),
  'memberships', (SELECT count(*) FROM funkyfarm.memberships),
  'records', (SELECT count(*) FROM funkyfarm.records),
  'record_history', (SELECT count(*) FROM funkyfarm.record_history),
  'idempotency_keys', (SELECT count(*) FROM funkyfarm.idempotency_keys),
  'user_preferences', (SELECT count(*) FROM funkyfarm.user_preferences),
  'public_content', (SELECT count(*) FROM funkyfarm.public_content),
  'community_reviewers', (SELECT count(*) FROM funkyfarm.community_reviewers)
);
