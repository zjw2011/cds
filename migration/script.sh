#!/bin/bash

NOCOLOR='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
LIGHTGRAY='\033[0;37m'
DARKGRAY='\033[1;30m'
LIGHTRED='\033[1;31m'
LIGHTGREEN='\033[1;32m'
YELLOW='\033[1;33m'
LIGHTBLUE='\033[1;34m'
LIGHTPURPLE='\033[1;35m'
LIGHTCYAN='\033[1;36m'
WHITE='\033[1;37m'

VENOM="${VENOM:-`which venom`}"
VENOM_OPTS="${VENOM_OPTS:---log debug --output-dir ./results --strict --stop-on-failure}"
CDSCTL="${CDSCTL:-`which cdsctl`}"
CDSCTL_CONFIG="${CDSCTL_CONFIG:-.cdsrc}"
ENGINE="${ENGINE:-/usr/bin/cds-engine-linux-amd64}"
ENGINE_CONFIG="${ENGINE_CONFIG:-/etc/cds-engine/cds-engine.toml}"

source ./functions.sh

rm -rf ./results
mkdir results

# Check that the two versions of CDS exists

# Step 1
echo -e "${BLUE}Step 1: install clean CDS master.${NOCOLOR}"
pause

echo -e "${WHITE}  - installing clean database and cache.${DARKGRAY}"
reset_database

echo -e "${WHITE}  - installing CDS master package.${DARKGRAY}"
install_master

echo -e "${WHITE}  - execute post installation script.${DARKGRAY}"
post_install
sleep 5

echo -e "${WHITE}  - running signup master:${DARKGRAY}"
CMD="${VENOM} run ${VENOM_OPTS} signup_admin_master.yml --var cdsctl=${CDSCTL} --var cdsctl.config=${CDSCTL_CONFIG}"
echo -e "    signup_admin_master.yml [${CMD}]"
${CMD} >signup_admin_master.yml.output 2>&1
check_failure $? signup_admin_master.yml.output

TOKEN=`cat token.out`
echo -e "${GREEN}end step 1, admin account available at http://192.168.33.10:4200/account/verify/cds.integration.tests.rw/${TOKEN}${NOCOLOR}"

# Step 2
echo -e "${BLUE}Step 2: migrate to CDS current.${NOCOLOR}"
pause

echo -e "${WHITE}  - installing CDS current package.${DARKGRAY}"
pre_install
install_current

echo -e "${WHITE}  - migrate api to current version.${DARKGRAY}"
migrate_current_part_1
sleep 5

echo -e "${WHITE}  - running admin account reset.${DARKGRAY}"
CMD="${VENOM} run ${VENOM_OPTS} reset_admin_account.yml --var cdsctl=${CDSCTL} --var cdsctl.config=${CDSCTL_CONFIG}"
echo -e "    reset_admin_account.yml [${CMD}]"
${CMD} >reset_admin_account.yml.output 2>&1
check_failure $? reset_admin_account.yml.output

echo -e "${WHITE}  - running create service consumers.${DARKGRAY}"
CMD="${VENOM} run ${VENOM_OPTS} create_consumers.yml --var cdsctl=${CDSCTL} --var cdsctl.config=${CDSCTL_CONFIG} --var engine=${ENGINE} --var engine.config=${ENGINE_CONFIG}"
echo -e "    create_consumers.yml [${CMD}]"
${CMD} >create_consumers.yml.output 2>&1
check_failure $? create_consumers.yml.output

echo -e "${WHITE}  - restart services with current version.${DARKGRAY}"
migrate_current_part_2
sleep 5

TOKEN=`cat token.out`
echo -e "${GREEN}end step 2, login with cds.integration.tests.rw:1A2Z3E4R5T6Y at http://192.168.33.10:4200${NOCOLOR}"
