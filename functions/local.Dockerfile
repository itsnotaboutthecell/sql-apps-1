FROM mcr.microsoft.com/azure-functions/node:4-node22@sha256:4ba7ae108e9e4cb1e806311f1e83bf784543b99d91a2cdbc8aa72bc092153334
ENV AzureWebJobsScriptRoot=/home/site/wwwroot AzureFunctionsJobHost__Logging__Console__IsEnabled=true
WORKDIR /home/site/wwwroot
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY dist/src ./dist/src
COPY dist/functions ./dist/functions
COPY assets/functions/local-package.json ./package.json
COPY assets/functions/local-host.json ./host.json
