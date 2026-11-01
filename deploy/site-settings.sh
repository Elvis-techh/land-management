# Where each Lindero on this droplet lives. Sourced by autodeploy.sh and
# update-from-build.sh, with the site's name as its argument. Not run by itself.
#
# Both sites' deploys run as root, and the live checkout's copy of these scripts
# is the only one that ever runs. The test site takes whatever branch is sent to
# it, so if it ran its own copy, a branch could change what runs as root on the
# machine the scale stations depend on. Its build only brings files to install.
# So a change to these scripts reaches the test site after it is merged and
# deployed to the live site, not before.

SCRIPTS=/opt/lindero/deploy
NODE_BIN=/opt/node22/bin
STATE_DIR=/var/lib/lindero-autodeploy
UNIT_DIR=/etc/systemd/system

case "${1:-live}" in
  live)
    SITE=live
    REPO=/opt/lindero
    SITE_USER=lindero
    FRONTEND_DEST=/var/www/lindero/frontend/dist
    SERVICE=lindero-api
    BUILD_BRANCH=deploy-build
    DEFAULT_PORT=3001
    STATE=$STATE_DIR/last-build
    ;;
  test)
    SITE=test
    REPO=/opt/lindero-test
    SITE_USER=lindero-test
    FRONTEND_DEST=/var/www/lindero-test/frontend/dist
    SERVICE=lindero-test-api
    BUILD_BRANCH=deploy-build-test
    DEFAULT_PORT=3101
    STATE=$STATE_DIR/last-build-test
    ;;
  *)
    echo "Unknown site '$1': it is either live or test." >&2
    exit 1
    ;;
esac

UNIT=$UNIT_DIR/$SERVICE.service
UNIT_SOURCE=$SCRIPTS/$SERVICE.service
