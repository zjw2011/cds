# Migration test

## Actions to run locally
```sh
    #1. source install.sh
    source functions.sh

    #2. build master cds version
    clone_master
    build_cds_master

    #3. build current cds version
    build_cds_current
```

## Boot the Vagrant vm and ssh into
```sh
    vagrant up
    vagrant ssh
```

## Actions to run in the vm
```sh
    #1. connect as root and go to cds sources
    sudo su
    cd /vagrant/migration

    #2. source functions.sh
    source functions.sh

    #3. install dependencies
    install_dependencies

    #4. package both cds versions
    package_cds_master
    package_cds_current

    #5. install master version
    reset_database
    install_master
    post_install
```

