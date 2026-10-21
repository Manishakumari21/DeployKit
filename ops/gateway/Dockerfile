FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf

RUN mkdir -p /etc/nginx/routes /etc/nginx/certs && \
    printf 'server {\n    listen 80 default_server;\n    return 404;\n}\n' > /etc/nginx/routes/000-default.conf

RUN mkdir -p /usr/share/nginx/registry-routes
COPY routes/deploykit-registry-tls.conf /usr/share/nginx/registry-routes/deploykit-registry-tls.conf

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
