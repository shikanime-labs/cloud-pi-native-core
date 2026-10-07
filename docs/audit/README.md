# Console provisioning audit

Grounding inventory for the Alchemy resource extraction: every artifact the
cloud-pi-native console provisions per project, zone, and platform tier, mapped
to a candidate `Resource` with lifecycle semantics.

Populated by the bootstrap audit; one document per service module is expected
here (keycloak, vault, gitlab, sonarqube, harbor, nexus, argocd) plus a
core-domain document for project, zone, stage, cluster, roles, and members.
