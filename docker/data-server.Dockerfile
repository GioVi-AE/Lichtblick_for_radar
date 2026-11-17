# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/data-server.nginx.conf /etc/nginx/conf.d/data.conf
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
