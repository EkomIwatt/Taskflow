# Python 3.12.8 is pinned deliberately. Render otherwise defaults to a Python
# with no prebuilt pydantic-core wheel, and the source build then fails on a
# read-only filesystem. This cost a redeploy on both previous projects.
FROM python:3.12.8-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first, so a code change does not invalidate the wheel layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY db ./db

EXPOSE 8000

# ONE worker, always. The realtime hub is in-process state (board -> set of
# connections); a second worker would serve half the clients from a registry
# that never sees the other half's broadcasts. Scaling out needs a Redis
# fan-out, which is explicitly out of scope. See backend/README.md.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips '*'"]
