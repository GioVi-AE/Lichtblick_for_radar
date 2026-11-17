# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM base AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY radar_kpi ./radar_kpi
COPY tests ./tests
COPY pytest.ini .
RUN python -m pytest -q

FROM base AS runtime
COPY radar_kpi ./radar_kpi
RUN useradd -r -u 10001 radar && mkdir -p /cache && chown radar /cache
USER radar
ENV RADAR_ROOTS="raw=/data/raw,processed=/data/processed" RADAR_CACHE_DIR=/cache
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8090/health', timeout=2)"
CMD ["uvicorn", "radar_kpi.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090"]
