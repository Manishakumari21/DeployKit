FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf

RUN mkdir -p /etc/nginx/routes && \
    printf 'server {\n    listen 80 default_server;\n    return 404;\n}\n' > /etc/nginx/routes/000-default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
