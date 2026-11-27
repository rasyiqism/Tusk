FROM edoburu/pgbouncer:v1.23.1-p0

USER root
RUN apk add --no-cache openssl \
    && mkdir -p /etc/pgbouncer/tls \
    && chown -R postgres:postgres /etc/pgbouncer/tls
USER postgres
