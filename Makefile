#
# Makefile
#

VERSION=1.0

all:
	echo 'make (build|run|stop|update)'

build:
	docker image build . -t portabilidade-mcp:$(VERSION)

run:
	docker container run -d --env-file .env -p 50002:3000 -v portabilidade_data:/data --name portabilidade-mcp portabilidade-mcp:$(VERSION)

stop:
	docker stop portabilidade-mcp 2>/dev/null || true
	docker rm portabilidade-mcp 2>/dev/null || true

update:
	git pull && make build && make stop && make run