#
# Makefile
#

VERSION=1.0

all:
	echo 'make (build|run|stop|update)'

build:
	docker image build . -t base-mcp:$(VERSION)

run:
	docker container run -d --env-file .env -p 50007:3000 -v base_data:/data --name base-mcp base-mcp:$(VERSION)

stop:
	docker stop base-mcp 2>/dev/null || true
	docker rm base-mcp 2>/dev/null || true

update:
	git pull && make build && make stop && make run