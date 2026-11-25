FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && python3 -m venv /opt/patroni && /opt/patroni/bin/pip install --no-cache-dir 'patroni[etcd3,psycopg3]==4.1.0' \
    && rm -rf /var/lib/apt/lists/*
COPY patroni.yml /etc/patroni.yml
ENTRYPOINT ["bash", "-ec", "install -d -m 700 -o postgres -g postgres /var/lib/postgresql/data/pgdata && exec gosu postgres /opt/patroni/bin/patroni /etc/patroni.yml"]
