# Stage 1 build React application
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./

RUN npm ci --legacy-peer-deps

COPY . .

RUN npm run build

# Stage 2 serve React application with Nginx
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf  
# if you remove ngix.conf from you ui then comment these upper line also beacuse it run you app on 3000 port inside docker else docker run you app on 80 port expose 3000 alsonot work without this upper command

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]