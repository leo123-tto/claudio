# Claudio 公用版：不装 ssh，不挂老板的数据和钥匙。Node 运行时从宿主机只读挂进 /opt/node。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -u 1000 -m claudio
ENV PATH=/opt/node/bin:$PATH HOME=/home/claudio
USER claudio
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/app/deploy/public/entrypoint.sh"]
