#!/usr/bin/env bash
# Rebuild the lab cluster after a Codespace restart (labs 6/7, branch
# feat/otel-o11y). Everything a restart wipes: the kind cluster (Docker lives
# on /tmp), every out-of-band Secret, MLflow experiments, the Phoenix system
# key, the Relay memory, the port-forwards. Idempotent where it can be.
#
#   nohup bash scripts/lab-restore.sh > /tmp/lab-restore.log 2>&1 &
#
# Expects: Codespaces secrets OPENAI_API_KEY and GOOGLE_API_KEY, and the
# harness-engineering memory artifacts in /workspaces/lab-data
# (relay-chunks.jsonl, relay-claims.jsonl, reference-graph.cypher,
# mcp_tools.py, ask.py).
set -uo pipefail
export KUBECONFIG=~/.kube/config
cd /workspaces/abox
log() { echo "[$(date '+%H:%M:%S')] $*"; }
J=/workspaces/.codespaces/shared/user-secrets-envs.json
sec() { python3 -c "import json;print(json.load(open('$J'))['$1'])"; }
D=/workspaces/lab-data; mkdir -p $D
GW_WAIT=0

log "== 0 docker data-root"
if ! docker info 2>/dev/null | grep -q "Docker Root Dir: /tmp/docker"; then
  sudo mkdir -p /etc/docker; printf '{"data-root":"/tmp/docker"}\n' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo pkill -x dockerd; for i in $(seq 1 30); do pgrep -x dockerd >/dev/null || break; sleep 1; done
  (sudo setsid nohup dockerd --containerd /run/containerd/containerd.sock --dns 168.63.129.16 > /tmp/dockerd.log 2>&1 < /dev/null &)
  for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
docker info | grep "Docker Root Dir"

log "== 1 make run"
if ! kind get clusters 2>/dev/null | grep -qx abox; then
  grep -q "opentofu-version" scripts/setup.sh || sed -i "s#sh -s -- --install-method standalone#sh -s -- --install-method standalone --opentofu-version $(curl -s https://api.github.com/repos/opentofu/opentofu/releases/latest | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"].lstrip("v"))')#" scripts/setup.sh
  make run || { log "make run failed"; exit 1; }
fi
pgrep -f /tmp/cloud-provider-kind >/dev/null || (setsid nohup /tmp/cloud-provider-kind > /tmp/cloud-provider-kind.log 2>&1 < /dev/null &)
kubectl get nodes

log "== 2 flux takeover"
kubectl -n flux-system annotate resourceset releases fluxcd.controlplane.io/reconcile=disabled --overwrite >/dev/null 2>&1
kubectl -n flux-system annotate resourcesetinputprovider releases-image fluxcd.controlplane.io/reconcile=disabled --overwrite >/dev/null 2>&1
for k in releases releases-crds; do kubectl -n flux-system patch kustomization $k --type merge -p '{"spec":{"suspend":true}}' >/dev/null 2>&1; done
kubectl -n flux-system patch ocirepository releases --type merge -p '{"spec":{"suspend":true}}' >/dev/null 2>&1
kubectl delete helmrelease ngrok-operator -n ngrok-operator --wait=false >/dev/null 2>&1; kubectl delete ns ngrok-operator --wait=false >/dev/null 2>&1

log "== 3 secrets"
for ns in kagent agentgateway-system otel-demo mlflow; do kubectl create ns $ns >/dev/null 2>&1; done
kubectl -n kagent get secret kagent-openai >/dev/null 2>&1 || kubectl -n kagent create secret generic kagent-openai --from-literal=OPENAI_API_KEY="$(sec OPENAI_API_KEY)" >/dev/null
kubectl -n agentgateway-system get secret agentgateway-llm-secrets >/dev/null 2>&1 || kubectl -n agentgateway-system create secret generic agentgateway-llm-secrets --from-literal=GEMINI_API_KEY="$(sec GOOGLE_API_KEY)" --from-literal=TRIAGE_LLM_KEY="$(openssl rand -hex 24)" >/dev/null
kubectl -n otel-demo get secret otel-demo-openai >/dev/null 2>&1 || kubectl -n otel-demo create secret generic otel-demo-openai --from-literal=OPENAI_API_KEY="$(sec OPENAI_API_KEY)" >/dev/null
# the bridge collector needs the Phoenix key Secret to start; a placeholder until step 7
kubectl -n mlflow get secret phoenix-otlp-key >/dev/null 2>&1 || kubectl -n mlflow create secret generic phoenix-otlp-key --from-literal=token=placeholder >/dev/null

log "== 4 apply bundle"
kubectl apply -k releases/crds 2>&1 | grep -v "unchanged\|Warning"
kubectl apply -k releases/ 2>&1 | grep -v "unchanged\|Warning"

log "== 5 wait for helm releases (force-reconcile install timeouts)"
for round in $(seq 1 40); do
  sleep 30
  NOTREADY=$(kubectl get helmrelease -A --no-headers | awk '$4!="True" {print $1"/"$2}')
  [ -z "$NOTREADY" ] && break
  for hr in $NOTREADY; do
    MSG=$(kubectl -n ${hr%/*} get helmrelease ${hr#*/} -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}')
    if echo "$MSG" | grep -qE "failed.*timeout|install failed|upgrade failed"; then
      TS=$(date +%s); kubectl -n ${hr%/*} annotate helmrelease ${hr#*/} reconcile.fluxcd.io/requestedAt=$TS reconcile.fluxcd.io/forceAt=$TS --overwrite >/dev/null
      log "forced $hr"
    fi
  done
  log "round $round not ready: $(echo $NOTREADY | tr '\n' ' ')"
done
kubectl get helmrelease -A --no-headers | awk '{print $1, $2, $4}'

log "== 6 mlflow experiments"
kubectl -n mlflow rollout status deploy/mlflow --timeout=600s | tail -1
(kubectl -n mlflow port-forward svc/mlflow-mlflow 5000:5000 > /dev/null 2>&1 &); sleep 4
for n in otel-demo kagent; do curl -s -X POST localhost:5000/api/2.0/mlflow/experiments/create -H "Content-Type: application/json" -d "{\"name\":\"$n\"}" >/dev/null; done
curl -s "localhost:5000/api/2.0/mlflow/experiments/search?max_results=10" | python3 -c "import json,sys;[print(e['experiment_id'], e['name']) for e in json.load(sys.stdin).get('experiments',[])]"

log "== 7 phoenix system key"
kubectl -n phoenix rollout status deploy/phoenix --timeout=900s | tail -1
(kubectl -n phoenix port-forward svc/phoenix-svc 6006:6006 > /dev/null 2>&1 &); sleep 4
PW=$(kubectl -n phoenix get secret phoenix-secret -o jsonpath='{.data.PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD}' | base64 -d)
curl -s -c $D/phx.cookies -o /dev/null -w "phoenix login %{http_code}\n" -X POST http://127.0.0.1:6006/auth/login -H "Content-Type: application/json" -d "{\"email\":\"admin@localhost\",\"password\":\"$PW\"}"
KEY=$(curl -s -b $D/phx.cookies http://127.0.0.1:6006/graphql -H "Content-Type: application/json" -d '{"query":"mutation { createSystemApiKey(input: {name: \"otel-collector\"}) { jwt } }"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['createSystemApiKey']['jwt'])")
kubectl -n mlflow delete secret phoenix-otlp-key >/dev/null 2>&1; kubectl -n mlflow create secret generic phoenix-otlp-key --from-literal=token="$KEY" >/dev/null
kubectl -n mlflow rollout restart deploy/otel-collector >/dev/null; log "phoenix key installed (${#KEY} chars)"

log "== 8 relay memory"
pip install -q mcp >/dev/null 2>&1
kubectl -n llama-cpp rollout status deploy/llama-cpp-embeddings --timeout=900s | tail -1
kubectl -n kagent rollout status deploy/qdrant-mcp --timeout=300s | tail -1
kubectl -n kagent rollout status deploy/neo4j-mcp --timeout=300s | tail -1
(kubectl -n kagent port-forward svc/qdrant-mcp 3101:3000 > /dev/null 2>&1 &); (kubectl -n kagent port-forward svc/neo4j-mcp 3104:3000 > /dev/null 2>&1 &); sleep 5
cd $D
python3 mcp_tools.py ingest http://127.0.0.1:3101/mcp vector_store relay-chunks.jsonl 2>&1 | tail -1
python3 mcp_tools.py ingest http://127.0.0.1:3101/mcp vector_store relay-claims.jsonl 2>&1 | tail -1
python3 mcp_tools.py cypher http://127.0.0.1:3104/mcp reference-graph.cypher 2>&1 | tail -1
cd /workspaces/abox

log "== 9 port-forwards"
(kubectl -n otel-demo port-forward svc/frontend-proxy 8080:8080 > /dev/null 2>&1 &)
(kubectl -n agentgateway-system port-forward svc/agentgateway-external 8090:80 > /dev/null 2>&1 &)
(kubectl -n otel-demo port-forward svc/jaeger 16686:16686 > /dev/null 2>&1 &)
(kubectl -n otel-demo port-forward svc/grafana 3000:80 > /dev/null 2>&1 &)
(kubectl -n otel-demo port-forward svc/agent 8010:8010 > /dev/null 2>&1 &)
sleep 4; sudo ss -ltnp | grep -oE ":(8080|8090|5000|6006|16686|3000|3101|3104|8010) " | sort -u | tr '\n' ' '; echo
log "== done: $(kubectl get pods -A --no-headers | wc -l) pods, $(kubectl get pods -A --no-headers | grep -c Running) running"
free -m | head -2
