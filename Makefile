#
# Makefile
#

VERSION=1.0

all:
	echo 'make (build|run|stop|update)'

build:
	docker image build . -t resend-mcp:$(VERSION)

run:
	docker container run -d --env-file .env -p 50002:3000 -v resend_data:/data --name resend-mcp resend-mcp:$(VERSION)

stop:
	docker stop resend-mcp 2>/dev/null || true
	docker rm resend-mcp 2>/dev/null || true

update:
	git pull && make build && make stop && make run