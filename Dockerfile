# Image optionnelle (pour les hébergeurs qui veulent du Docker).
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
