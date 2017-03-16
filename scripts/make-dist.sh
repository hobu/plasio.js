#!/bin/bash
# deploy.sh
# Setup a deploy directory for the build
#

die () {
    echo $*
    exit 1
}

echo ":: checking tree ..."
LATEST_COMMIT=`git rev-parse HEAD 2>/dev/null`
LATEST_TAG=`git describe --abbrev=0 --tags 2>/dev/null`
CWD=`pwd`


validate() {
    if [[ "$LATEST_TAG" = "" ]] ; then
        die "ERROR: You don't have any annotated tags setup, cannot proceed.  Annotate tag and try again."
    fi

    LATEST_TAG_COMMIT=`git rev-list -n 1 $LATEST_TAG`

    if [[ "$LATEST_TAG_COMMIT" != "$LATEST_COMMIT" ]] ; then
        die "ERROR: The branch head($LATEST_COMMIT) is different from the latest tag($LATEST_TAG, $LATEST_TAG_COMMIT), will not proceed. Create a new annotated tag."
    fi
}

if [[ "$1" == "HEAD" ]] ; then
    LATEST_TAG="HEAD"
else
    validate
fi

# print some information for the user
echo ":: the latest ANNOTATED tag is: $LATEST_TAG, which points to commit: $LATEST_COMMIT, which is the current head."
echo
echo ":: going to build release: $LATEST_TAG"
echo ":: OK to proceed... press a key"

read

TEMP_DIR=`mktemp -d`
echo ":: checking out code to $TEMP_DIR ... "
git --work-tree=$TEMP_DIR checkout $LATEST_TAG -- .

echo ":: building ... may take a moment."
cd $TEMP_DIR && \
    cd lib && npm install && cd .. && \
    bash scripts/production.sh --no-confirm

if [ $? -eq 0 ] ; then
    echo ":: build succeeded."
else
    echo ":: build failed."
    exit 1
fi

cd $CWD

echo ":: staging release $LATEST_TAG in $CWD/releases ..."

# Make the needed directories
OUT_DIR=$CWD/releases/$LATEST_TAG
LATEST_DIR=$CWD/releases/latest
DIST_DIR=$CWD/dist

mkdir -p $OUT_DIR

cp "$TEMP_DIR/plasio.js" "$OUT_DIR/plasio.js"
cp "$TEMP_DIR/renderer.cljs.js" "$OUT_DIR/plasio-renderer.cljs.js"

# overwrite latest with the most recent build
if [ -d "$LATEST_DIR" ] ; then
    rm -rf "$LATEST_DIR"
fi

cp -r $OUT_DIR $LATEST_DIR

echo ":: now building docs..."
cd lib && npm run docs && cd ..

TEMP_DOCS_DIR=`mktemp -d`
cp -rv lib/docs/* "$TEMP_DOCS_DIR/"

echo ":: deploying docs ..."
git checkout gh-pages && rm -rf * && cp -rv "$TEMP_DOCS_DIR/*" .
echo "plasiojs.io" > CNAME
git add . && git commit -m "Update docs for release $LATEST_TAG" && git push origin gh-pages


echo ":: cleaning up."
rm -rf $TEMP_DOCS_DIR
rm -rf $TEMP_DIR

echo ":: done. Output in releases/$LATEST_TAG directory."

