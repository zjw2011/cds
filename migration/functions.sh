#!/bin/bash

clone_master() {
    rm -rf master
    git clone https://github.com/ovh/cds.git --branch master --single-branch master --depth 1
}

build_cds_master() {
    cp ./master/cli/cdsctl/Makefile ./master/cli/cdsctl/Makefile.bkp
    sed "s/build: \$(TARGET_DIR) \$(TARGET_BINARIES_VARIANT) \$(TARGET_BINARIES)/build: \$(TARGET_DIR) \$(TARGET_BINARIES_VARIANT)/g" ./master/cli/cdsctl/Makefile.bkp > ./master/cli/cdsctl/Makefile
    (cd master && OS="linux" ARCH="amd64" GO111MODULE=on make build)
}

build_cds_current() {
    (cd .. && OS="linux" ARCH="amd64" GO111MODULE=on make clean build)
}

install_dependencies() {
    # debpacker
    docker run -it \
    -v /vagrant:/usr/src/cds \
    -w /usr/src/cds/tools/debpacker \
    -e ARCH=amd64 \
    golang:1.13.4 make build
    rm -f /usr/bin/debpacker
    ln -s /vagrant/tools/debpacker/dist/debpacker-linux-amd64 /usr/bin/debpacker

    # databases
    docker pull redis
    docker pull postgres

    # smtp mock
    (cd /vagrant/tools/smtpmock/cmd/smtpmocksrv && docker build -t smtpmocksrv .)
    docker rm -f smtpmocksrv
    docker run  -p 2023:2023 -p 2024:2024 -d --name  smtpmocksrv smtpmocksrv

    # venom
    curl https://github.com/ovh/venom/releases/download/v0.27.0/venom.linux-amd64 -L -o /usr/bin/venom
    chmod +x /usr/bin/venom
}

reset_database() {
    docker rm -f redis-cds postgres-cds
    docker run -d -p 6379:6379 --name redis-cds redis
    docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=cds -e POSTGRES_USER=cds -e POSTGRES_DB=cds --name postgres-cds postgres
}

package_cds_master() {
    (cd /vagrant/migration/master && make deb)
}

package_cds_current() {
    rm -rf /vagrant/dist /vagrant/target
    (cd /vagrant && make deb)
}

install_master() {
    dpkg -i /vagrant/migration/master/target/cds-engine.deb
}

install_current() {
    dpkg -i /vagrant/target/cds-engine.deb
}

pre_install() {
    systemctl stop cds-engine
}

post_install() {
    usermod -aG docker cds-engine

    chmod +x /usr/bin/cds-engine-linux-amd64
    cp /var/lib/cds-engine/cdsctl-linux-amd64-nokeychain /usr/bin/cdsctl
    chmod +x /usr/bin/cdsctl

    (mkdir -p /var/lib/cds-engine/artifacts && chown cds-engine:cds-engine /var/lib/cds-engine/artifacts)

    /usr/bin/cds-engine-linux-amd64 database upgrade --db-host localhost --db-port 5432 --db-user cds --db-password cds --db-name cds --db-sslmode disable --migrate-dir /var/lib/cds-engine/sql

    /usr/bin/cds-engine-linux-amd64 config new api ui hatchery:swarm hooks > /etc/cds-engine/cds-engine.toml

    export IP_ADDR=192.168.33.10
    /usr/bin/cds-engine-linux-amd64 config edit /etc/cds-engine/cds-engine.toml --output /etc/cds-engine/cds-engine.toml \
    api.defaultArch=amd64 \
    api.defaultOS=linux \
    api.directories.download=/var/lib/cds-engine \
    api.artifact.mode=local \
    api.artifact.local.baseDirectory=/var/lib/cds-engine/artifacts \
    api.smtp.disable=false \
    api.smtp.port=2023 \
    api.smtp.host=localhost \
    api.url.api=http://$IP_ADDR:8081 \
    api.url.ui=http://$IP_ADDR:4200 \
    hooks.name=hooks \
    hooks.api.http.url=http://$IP_ADDR:8081 \
    ui.name=ui \
    ui.url=http://$IP_ADDR:4200 \
    ui.staticdir=/var/lib/cds-engine/ui \
    ui.api.http.url=http://$IP_ADDR:8081 \
    ui.http.port=4200 \
    log.level=debug \
    hatchery.swarm.commonConfiguration.name=hatchery-swarm \
    hatchery.swarm.ratioService=50 \
    hatchery.swarm.commonConfiguration.api.http.url=http://$IP_ADDR:8081 \
    hatchery.swarm.dockerEngines.default.host=unix:///var/run/docker.sock \
    hatchery.swarm.dockerEngines.default.maxContainers=10

    sed -i 's/Environment=.*/Environment="CDS_SERVICE=api hooks hatchery:swarm ui"/' /lib/systemd/system/cds-engine.service
    systemctl daemon-reload

    systemctl restart cds-engine
}

migrate_current_part_1() {
    chmod +x /usr/bin/cds-engine-linux-amd64
    cp /var/lib/cds-engine/cdsctl-linux-amd64-nokeychain /usr/bin/cdsctl
    chmod +x /usr/bin/cdsctl

    /usr/bin/cds-engine-linux-amd64 database upgrade --db-host localhost --db-port 5432 --db-user cds --db-password cds --db-name cds --db-sslmode disable --migrate-dir /var/lib/cds-engine/sql

    cp /etc/cds-engine/cds-engine.toml /etc/cds-engine/cds-engine.bkp.toml
    /usr/bin/cds-engine-linux-amd64 config regen /etc/cds-engine/cds-engine.toml /etc/cds-engine/cds-engine.toml

    /usr/bin/cds-engine-linux-amd64 config edit /etc/cds-engine/cds-engine.toml --output /etc/cds-engine/cds-engine.toml \
    api.name=api \
    api.auth.local.enabled=true

    sed -i 's/Environment=.*/Environment="CDS_SERVICE=api"/' /lib/systemd/system/cds-engine.service
    systemctl daemon-reload
    systemctl restart cds-engine
}

migrate_current_part_2() {
    sed -i 's/Environment=.*/Environment="CDS_SERVICE=api hooks hatchery:swarm ui"/' /lib/systemd/system/cds-engine.service
    systemctl daemon-reload
    systemctl restart cds-engine
}

pause() {
    while true; do
        read -p "Press enter to continue" key
        case $key in
            * ) break;;
        esac
    done
}

check_failure() {
    exit_status=$1
    if [ $exit_status -ne 0 ]; then
        echo -e "  ${LIGHTRED}FAILURE${RED}\n"
        cat $2
        echo -e ${NOCOLOR}
        exit $exit_status
    fi
}
