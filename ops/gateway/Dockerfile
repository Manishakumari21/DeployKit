FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf

RUN mkdir -p /etc/nginx/routes /etc/nginx/certs && \
    printf 'server {\n    listen 80 default_server;\n    return 404;\n}\n' > /etc/nginx/routes/000-default.conf

# Package the infrastructure registry TLS route outside the runtime-mounted
# /etc/nginx/routes volume. That volume intentionally owns application routes
# and would shadow files baked into /etc/nginx/routes.
RUN mkdir -p /usr/share/nginx/registry-routes
COPY routes/deploykit-registry-tls.conf /usr/share/nginx/registry-routes/deploykit-registry-tls.conf

# Port 80 serves application traffic + ACME HTTP-01 challenges; 443 serves
# TLS-terminated project routes. No default 443 block exists on purpose: an
# ssl listener without a certificate fails `nginx -t`, so HTTPS blocks are
# rendered per verified domain only when its certificate is valid.
EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
