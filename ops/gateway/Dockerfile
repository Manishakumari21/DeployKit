FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf

RUN mkdir -p /etc/nginx/routes /etc/nginx/certs && \
    printf 'server {\n    listen 80 default_server;\n    return 404;\n}\n' > /etc/nginx/routes/000-default.conf

# Port 80 serves application traffic + ACME HTTP-01 challenges; 443 serves
# TLS-terminated project routes. No default 443 block exists on purpose: an
# ssl listener without a certificate fails `nginx -t`, so HTTPS blocks are
# rendered per verified domain only when its certificate is valid.
EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
