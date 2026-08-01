{{/*
CloudAtlas chart helpers.
*/}}
{{- define "cloudatlas.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "cloudatlas.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "cloudatlas.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "cloudatlas.databaseUrl" -}}
{{- if .Values.postgres.enabled }}
{{- printf "postgres://%s:%s@%s-postgres:%s/%s" .Values.postgres.username .Values.postgres.password (include "cloudatlas.fullname" .) "5432" .Values.postgres.database }}
{{- else }}
{{- .Values.postgres.externalUrl | quote }}
{{- end }}
{{- end }}
