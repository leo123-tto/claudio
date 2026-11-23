# Claudio 盒子版：只装 ssh 客户端（拉起 5090 语音档要用）。
# Node 不打进镜像，运行时从宿主机只读挂进 /opt/node；代码和数据也都是挂进来的。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -u 1000 -m claudio
ENV PATH=/opt/node/bin:$PATH HOME=/home/claudio
USER claudio
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/app/deploy/box/entrypoint.sh"]
