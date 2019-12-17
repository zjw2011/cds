# -*- mode: ruby -*-
# vi: set ft=ruby :

Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/xenial64"

  config.vm.network "private_network", ip: "192.168.33.10"

  config.vm.provider "virtualbox" do |v|
    v.memory = 4096
    v.cpus = 4
  end

  config.vm.provision "docker" do |d|      
  end

  $script = <<-SCRIPT
    apt-get install -y zip git make pkg-config curl wget zsh
    chsh -s /bin/zsh root
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
  SCRIPT

  config.vm.provision "shell", inline: $script
end
