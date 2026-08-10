export const classificationObservationReadModelSql = `(
  SELECT
    link.id,
    candidate.source_id,
    link.source_product_id,
    link.candidate_key,
    candidate.reference_type_id,
    candidate.scope,
    link.subject_kind,
    link.subject_key,
    link.source_value,
    candidate.normalized_source_value,
    candidate.context,
    candidate.context_key,
    evidence.evidence,
    link.status,
    link.issue_reason,
    link.resolved_reference_value_id,
    link.mapping_id,
    link.rule_id,
    link.resolution_revision,
    state.processor_version,
    state.classifier_version,
    state.classification_fingerprint,
    link.active,
    link.first_seen_at,
    link.last_seen_at,
    link.created_at,
    link.updated_at
  FROM source_product_classification_links link
  JOIN classification_candidates candidate ON candidate.id = link.candidate_id
  JOIN source_product_classification_evidence evidence ON evidence.id = link.evidence_id
  JOIN source_product_classification_states state ON state.source_product_id = link.source_product_id
)`;
