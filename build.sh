#!/bin/bash

nvm use 18
yarn package

# clear previous builds
rm -rf pkg/
rm -rf companion-module-newblue-captivate/
rm -f companion-module-newblue-captivate.zip

# extract new build
tar -xf pkg.tgz

# rename extracted folder
mv pkg companion-module-newblue-captivate

# zip the build
zip -r companion-module-newblue-captivate.zip companion-module-newblue-captivate/*
