.PHONY: check autoinstall-package autoinstall-deploy autoinstall-rollback

check:
	cd packages/dkrypt && bun test && bun run typecheck && bun run typecheck:web

autoinstall-package:
	gmake -C packages/autoinstall clean package

autoinstall-deploy:
	./scripts/autoinstall-release deploy

autoinstall-rollback:
	@test -n "$(PACKAGE)"
	./scripts/autoinstall-release rollback "$(PACKAGE)"
