# Deployment Guide

Deploy pg-phoenix-image as a single-pod StatefulSet in Kubernetes.

## Prerequisites

- Kubernetes cluster with CSI driver for persistent volumes (e.g. EBS gp3)
- Container registry with pg-phoenix-image image pushed
- Namespace created (examples use `db`)

## StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg-phoenix-image
  namespace: db
spec:
  serviceName: pg-phoenix-image
  replicas: 1
  selector:
    matchLabels:
      app: pg-phoenix-image
  template:
    metadata:
      labels:
        app: pg-phoenix-image
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9187"
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: postgres
          image: <registry>/pg-phoenix-image:18-latest
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: pg-phoenix-image-credentials
                  key: password
            # Backup config — see docs/backup-setup.md
            # - name: WALG_S3_PREFIX
            #   value: "s3://bucket/pg-phoenix-image-prod"
          volumeMounts:
            - name: pg-data
              mountPath: /var/lib/postgresql
            # Optional: config overrides
            # - name: pg-overrides
            #   mountPath: /etc/postgresql/conf.d
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 4Gi
          livenessProbe:
            exec:
              command: ["pg_isready", "-U", "postgres"]
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "postgres"]
            initialDelaySeconds: 5
            periodSeconds: 5
          lifecycle:
            preStop:
              exec:
                command: ["pg_ctl", "stop", "-m", "fast", "-w"]
      volumes:
        # Optional: ConfigMap overrides (only settings you want to change)
        # - name: pg-overrides
        #   configMap:
        #     name: pg-phoenix-image-config
  volumeClaimTemplates:
    - metadata:
        name: pg-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: <your-storage-class>
        resources:
          requests:
            storage: 50Gi
```

### Key points

- **`terminationGracePeriodSeconds: 30`** — gives PG time to checkpoint on shutdown. Increase for large `shared_buffers`.
- **preStop hook** — `pg_ctl stop -m fast` ensures clean shutdown before kubelet sends SIGKILL.
- **Probes** — `pg_isready` ships with PG. Readiness gates traffic, liveness restarts on hang.
- **Config overrides** — mount a ConfigMap into `conf.d/` to override individual settings without replacing the full `postgresql.conf`. See [architecture/slow-query-log.md](architecture/slow-query-log.md) for how `include_dir` works.
- **Metrics** — the Prometheus annotations in the pod template require an exporter sidecar to serve `/metrics`. See [monitoring.md](monitoring.md) for the `postgres-exporter` sidecar manifest and alerting rules.

## Services

```yaml
# Headless — required by StatefulSet
apiVersion: v1
kind: Service
metadata:
  name: pg-phoenix-image
  namespace: db
spec:
  clusterIP: None
  selector:
    app: pg-phoenix-image
  ports:
    - port: 5432
---
# ClusterIP — stable endpoint for clients
apiVersion: v1
kind: Service
metadata:
  name: pg-phoenix-image-rw
  namespace: db
spec:
  selector:
    app: pg-phoenix-image
  ports:
    - port: 5432
      targetPort: 5432
```

## Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: pg-phoenix-image-credentials
  namespace: db
type: Opaque
stringData:
  password: <generate-a-strong-password>
```

## Config Overrides (Optional)

Only include settings you want to change from the image defaults:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pg-phoenix-image-config
  namespace: db
data:
  override.conf: |
    shared_buffers = 2GB
    work_mem = 64MB
    log_min_duration_statement = 200
```

Mount into `conf.d/` — see the commented-out volume mount in the StatefulSet above.

## Storage

- **Storage class**: use `WaitForFirstConsumer` binding mode to co-locate PVC and pod in the same AZ.
- **Reclaim policy**: use `Retain` for production to protect against accidental PVC deletion.
- **Sizing**: PG data + WAL + logs. Start with 2-3x expected data size. Monitor with `pg_database_size()`.

## Spot Instances

Spot saves 60-70% on compute. pg-phoenix-image is designed for this — WAL-G backups are continuous, startup is fast (no downloads), and the preStop hook ensures clean shutdown.

### Tolerations + Affinity

```yaml
tolerations:
  - key: "node_type"
    operator: "Equal"
    value: "spot"
    effect: "NoExecute"
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 1
        preference:
          matchExpressions:
            - key: eks.amazonaws.com/capacityType
              operator: In
              values: [SPOT]
```

**Preferred**, not required — falls back to on-demand if no spot capacity.

### Priority Class

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: database-critical
value: 1000
globalDefault: false
description: "Database workloads — preempt lower-priority pods for fast rescheduling"
```

Add `priorityClassName: database-critical` to the pod spec.

### Image Pre-Pull

DaemonSet that pulls pg-phoenix-image on every node, so spot rescheduling doesn't wait for image download:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: pg-phoenix-image-prepull
spec:
  selector:
    matchLabels:
      app: pg-phoenix-image-prepull
  template:
    metadata:
      labels:
        app: pg-phoenix-image-prepull
    spec:
      initContainers:
        - name: pull
          image: <registry>/pg-phoenix-image:18-latest
          command: ["true"]
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 1Mi
```

### AWS Node Termination Handler

Install the [AWS Node Termination Handler](https://github.com/aws/aws-node-termination-handler) as an EKS addon or Helm chart. It reacts to rebalance recommendations and spot interruption notices, cordoning and draining the node before the 2-minute termination window.

### Spot Interruption Timeline

```
Signal → NTH cordons + drains → preStop (pg_ctl stop) → EBS detach → reschedule → EBS attach → PG starts
         ~minutes warning         2-5s                    1-5s          2-10s         1-5s        2-5s
                                                          └── DOWNTIME: ~10-25s total ──────────────┘
```

## Verification

After deploying:

```bash
# Pod running
kubectl get pods -n db -l app=pg-phoenix-image

# PG accepting connections
kubectl exec -n db pg-phoenix-image-0 -- pg_isready -U postgres

# Check PG version
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT version();"

# Check pg_stat_statements loaded
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT count(*) FROM pg_stat_statements;"
```

Next: [Configure backups](backup-setup.md)
