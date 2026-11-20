FROM mysql:8.0

RUN command -v curl >/dev/null 2>&1 || (microdnf install -y curl-minimal && microdnf clean all)

COPY run.sh backup.sh call-cron.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/run.sh /usr/local/bin/backup.sh /usr/local/bin/call-cron.sh

ENTRYPOINT ["/usr/local/bin/run.sh"]
