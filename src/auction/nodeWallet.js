import { get, post } from './rest';
import { auctionAddress, auctionFee, sendTx } from './explorer';
import { Address, Transaction } from '@coinbarn/ergo-ts';
import { encodeLong, encodeStr } from './serializer';
import {addBid, getMyBids, getWalletAddress, isWalletSaved} from './helpers';

function getUrl(url) {
    if (!url.startsWith('http')) url = 'http://' + url;
    if (url.endsWith('/')) url = url.slice(0, url.length - 1);
    return url;
}

export async function getInfo(url) {
    return get(getUrl(url) + '/info').then((res) => res.json());
}

export async function getAddress(
    url = JSON.parse(sessionStorage.getItem('wallet')).url,
    apiKey = JSON.parse(sessionStorage.getItem('wallet')).apiKey
) {
    return await post(
        getUrl(url) + '/wallet/deriveKey',
        { derivationPath: 'm' },
        apiKey
    ).then((res) => res.json());
}

export async function getAssets(
    url = JSON.parse(sessionStorage.getItem('wallet')).url,
    apiKey = JSON.parse(sessionStorage.getItem('wallet')).apiKey
) {
    return await get(getUrl(url) + '/wallet/balances', apiKey).then((res) =>
        res.json()
    );
}

export async function boxToRaw(boxId,url = JSON.parse(sessionStorage.getItem('wallet')).url) {
    return await get(getUrl(url) + `/utxo/byIdBinary/${boxId}`)
        .then((res) => res.json())
        .then(res => res.bytes)
}

export async function generateTx(
    request,
    url = JSON.parse(sessionStorage.getItem('wallet')).url,
    apiKey = JSON.parse(sessionStorage.getItem('wallet')).apiKey
) {
    return await post(
        getUrl(url) + '/wallet/transaction/generate',
        request,
        apiKey
    ).then((res) => res.json());
}

export async function unspentBoxes(
    amount,
    url = JSON.parse(sessionStorage.getItem('wallet')).url,
    apiKey = JSON.parse(sessionStorage.getItem('wallet')).apiKey
) {
    let req = {
        requests: [
            {
                address: '4MQyML64GnzMxZgm',
                value: amount,
            },
        ],
        fee: auctionFee,
    };
    return await post(
        getUrl(url) + '/wallet/transaction/generateUnsigned',
        req,
        apiKey
    )
        .then((res) => res.json())
        .then(res => res.inputs.map(inp => inp.boxId))
        .then(res => res.map(id => get(getUrl(url) + `/utxo/byId/${id}`).then(res => res.json())))
        .then(res => Promise.all(res))
        .catch(_ => {
            return get(
                getUrl(url) + '/wallet/boxes/unspent',
                apiKey
            ).then(res => res.json())
                .then(res => res.sort((a, b) => b.box.value - a.box.value))
                .then(res => {
                    let needed = amount + auctionFee
                    let selected = []
                    for (let i = 0; i < res.length; i++) {
                        selected.push(res[i].box)
                        needed -= res[i].box.value
                        if (needed <= 0) break
                    }
                    if (needed > 0) return []
                    return selected
                })
                .catch(_ => [])
        });
}

export function auctionTxRequest(
    initial,
    bidder,
    tokenId,
    tokenAmount,
    step,
    start,
    end,
    description
) {
    let tree = new Address(bidder).ergoTree;
    let info = `${initial},${step},${start},${end}`;
    let req = {
        requests: [
            {
                address: auctionAddress,
                value: initial,
                assets: [
                    {
                        tokenId: tokenId,
                        amount: tokenAmount,
                    },
                ],
                registers: {
                    R4: encodeStr(tree),
                    R5: encodeLong(end, true),
                    R6: encodeLong(step),
                    R7: encodeStr(description, true),
                    R8: encodeStr(tree),
                    R9: encodeStr(info, true),
                },
            },
        ],
        fee: auctionFee,
    };
    return generateTx(req).then((res) => {
        let tx = Transaction.formObject(res);
        sendTx(tx);
        let bid = {
            token: {
                tokenId: tokenId,
                amount: tokenAmount,
            },
            boxId: tx.inputs[0].boxId,
            txId: tx.id,
            tx: res,
            status: 'pending mining',
            amount: initial,
            isFirst: true,
        };
        addBid(bid);
    });
}

export async function bidTxRequest(box, amount) {
    let ourAddr = getWalletAddress()
    return unspentBoxes(amount).then(boxes => {
        if (boxes.length === 0) throw new Error('Could not get enough unspent boxes for the bid form your wallet!')
        let ids = boxes.map(box => box.boxId)
        let raws = ids.concat([box.id]).map(id => boxToRaw(id))
        return Promise.all(raws).then(inputsRaw => {
            let change = {
                address: ourAddr,
                value: boxes.map(box => box.value).reduce((a, b) => a + b) - amount - auctionFee
            }
            let changeAsset = {}
            boxes.forEach(box => box.assets.forEach(asset => {
                if (asset.tokenId in changeAsset) changeAsset[asset.tokenId] += asset.amount
                else changeAsset[asset.tokenId] = asset.amount
            }))
            change.assets = Object.entries(changeAsset).map((a, _) => {
                return {
                    tokenId: a[0],
                    amount: a[1]
                }
            })
            let tree = new Address(ourAddr).ergoTree;
            let newBox = {
                value: amount,
                address: auctionAddress,
                assets: box.assets,
                registers: {
                    R4: box.additionalRegisters.R4,
                    R5: box.additionalRegisters.R5,
                    R6: box.additionalRegisters.R6,
                    R7: box.additionalRegisters.R7,
                    R8: encodeStr(tree),
                    R9: box.additionalRegisters.R9,
                }
            }
            let returnBidder = {
                value: box.value,
                address: box.bidder
            }
            let request = {
                requests: [newBox, returnBidder, change],
                fee: auctionFee,
                inputsRaw: inputsRaw
            }

            return generateTx(request).then((res) => {
                let tx = Transaction.formObject(res);
                sendTx(tx);
                let bid = {
                    token: box.assets[0],
                    boxId: box.id,
                    txId: tx.id,
                    tx: res,
                    status: 'pending mining',
                    amount: amount,
                    isFirst: false,
                };
                addBid(bid);
            });
        })
    })
}

export function withdrawFinishedAuctions(boxes) {
    if (!isWalletSaved()) return
    let winnerVal = 1000000
    boxes.filter(box => box.remBlock === 0).forEach(box => {
        boxToRaw(box.id).then(res => {
            let winner = {
                value: winnerVal,
                address: box.bidder,
                assets: box.assets
            }
            let seller = {
                value: box.value - auctionFee - winnerVal,
                address: box.seller
            }
            let request = {
                requests: [winner, seller],
                fee: auctionFee,
                inputsRaw: [res]
            }

            return generateTx(request).then((res) => {
                console.log(res)
                let tx = Transaction.formObject(res);
                sendTx(tx);
            }).catch(res => console.log(res));
        })
    })
}
