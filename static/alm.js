
var EndPoint_Create = "/alm_create";
var EndPoint_Join = "/alm_join";
var EndPoint_Cand = "/alm_cand";

var WebRTC_PeerConnection_Servers = null;
var WebRTC_PeerConnection_Argument = {optional: [{RtpDataChannels:true}]};
var WebRTC_DataChannel_Options = {reliable: false};

var WebRTC_ALM = function(host) {
    this.ws_ = null;
    this.join_ = false;
    this.server_ = 'ws://' + host;
    this.broadcaster_ = false;
    this.upstreams = [];
    this.downstreams = [];
    this.max_upstreams = 1;  // TODO
    this.max_downstreams = 1;
    this.handler = null;
    this.chunk_size = window.webkitRTCPeerConnection ? 500 : 20000;
    this.blob_table = null;
};
var WebRTC_ALM_DataChannelInfo = function(alm) {
    this.alm = alm;
    this.connected = false;
    this.wsock = null;
    this.ekey = null;
    this.conn = null; // peerconnection
    this.ch = null;   // datachannel
};

WebRTC_ALM.prototype.multicast = function(data) {
    for(var i = 0; i < this.downstreams.length; ++i) {
        //console.log("multicast", data);
        this.downstreams[i].ch.send(data);
    }
};

WebRTC_ALM.prototype.multicast_blob = function(blob, title) { // arrayBuffer
    var t = title || "untitled-" + (+new Date());
    var num = Math.ceil(blob.byteLength / this.chunk_size);
    //console.log('doing multicast', num);
    for (var i = 0; i < num; i++){
        var start = i * this.chunk_size;
        var d = RawDeflate.deflate(JSON.stringify({
            m : "blob",
            i : i,
            d : Array.apply(null, new Uint8Array(
                    blob.slice(start, Math.min((start + this.chunk_size), blob.byteLength))
                )),
            n : num,
            t : t
        }));
        console.log("multicast_blob-size:", d.length);
        this.multicast(d);
    }
};

WebRTC_ALM.prototype.create_group = function (group_id, ok_callback, err_callback, dc_callback) {
    var owner = this;
    if (this.join_) throw 'already created/joined group';
    this.dc_callback = function(){
        dc_callback.call(this);
        delete this.dc_callback;
    };
    this.ws_ = new WebSocket(this.server_ + EndPoint_Create);
    this.ws_.onopen = function(ev) {
        owner.ws_.send(JSON.stringify({'g': group_id}));
    };
    this.ws_.onmessage = function(ev) {
        console.log('[create group] recv msg: ' + ev.data);
        msg = JSON.parse(ev.data);
        if (msg.r == 'ok') {
            owner.ws_.self = owner;
            owner.ws_.onmessage = owner._groupRootRecvMsg;
            ok_callback();
        } else {
            owner._close();
            err_callback();
        }
    };
};
  
WebRTC_ALM.prototype.join_group = function (group_id, ok_callback, err_callback, msg_callback) {
    var owner = this;
    if (this.join_) throw 'already created/joined group';
    this.handler = msg_callback;

    owner.ws_ = new WebSocket(owner.server_ + EndPoint_Join);
    owner.ws_.onopen = function(ev) {
        var upstrm = new WebRTC_ALM_DataChannelInfo(this);
        upstrm.conn = new webkitRTCPeerConnection(
            WebRTC_PeerConnection_Servers, WebRTC_PeerConnection_Argument
        );
        upstrm.conn.onicecandidate = function(ev) {
            if (ev.candidate) {
                console.log('[join group] onicecandidate');
                owner.ws_.send(JSON.stringify({'ice':JSON.stringify(ev.candidate)}));
            }
        };
        upstrm.ch = upstrm.conn.createDataChannel(group_id, WebRTC_DataChannel_Options);
        upstrm.ch.onopen = function() {
            console.log("DataChannel: onOpen");
            ok_callback();
        };
        upstrm.ch.alm = owner;// can be removed.
        upstrm.ch.onmessage = function(ev){
            owner.ReceiveMessageFromUpstream(ev);
        }
        owner.upstreams.push(upstrm);
        
        upstrm.conn.createOffer(function(offer) {
            console.log(offer);
            upstrm.conn.setLocalDescription(offer);
            owner.ws_.send(JSON.stringify({'g': group_id, 's': JSON.stringify(offer)}));
            owner.ws_.onmessage = function(ev) {
                console.log('[join group] recv msg: ' + ev.data);
                msg = JSON.parse(ev.data);
                if (msg.r && msg.r == 'ok') {
                    answer_desc = new RTCSessionDescription({type:'answer', sdp:JSON.parse(msg.s).sdp});
                    upstrm.conn.setRemoteDescription(answer_desc);
                } else if (msg.ice) {
                    console.log('[join group] added ice');
                    upstrm.conn.addIceCandidate(new RTCIceCandidate(JSON.parse(msg.ice)));
                } else {
                    owner._close();
                    err_callback();
                }
            };
        });
    };
};
WebRTC_ALM.prototype._groupRootRecvMsg = function(ev) {
    console.log('[group root] recv msg: ' + ev.data);
    var msg = JSON.parse(ev.data);
    if (msg.m == 'new') {
        this.self._receivedNewMemberMsg(msg.e, msg.s);
    }
}
WebRTC_ALM.prototype._receivedNewMemberMsg = function(ekey, offer_sdp) {
    console.log('[recv new-member] ephemeral_key=' + ekey);
    if (this.downstreams.length < this.max_downstreams) {
        var info = new WebRTC_ALM_DataChannelInfo(this);
        info.ekey = ekey;
        info.start_candidate_process(offer_sdp);
    } else {
        var msg = JSON.stringify({'m':'new','e':ekey,'s':offer_sdp});
        //msg = new Zlib.Deflate(msg).compress();
        msg = RawDeflate.deflate(msg);
        console.log('compressed_msg_size=' + msg.length);
        for(var i = 0; i < this.downstreams.length; ++i) {
            this.downstreams[i].ch.send(msg);
        }
        console.log('[recv new-member] relayed ' + this.downstreams.length + ' peers');
    }
};
WebRTC_ALM.prototype._close = function(ev) {
    if (this.ws_ != null) {
        this.ws_.close();
        this.ws_ = null;
    }
    this.join_ = false;
    this.broadcaster_ = false;
};

WebRTC_ALM.prototype.is_broadcaster = function() { return this.broadcaster_; };

WebRTC_ALM_DataChannelInfo.prototype.start_candidate_process = function(offer_sdp) {
    console.log('[cand] start');
    var info = this;
    info.wsock = new WebSocket(this.alm.server_ + EndPoint_Cand);
    info.wsock.owner = this;
    info.wsock.onopen = function(ev) {
        info.conn = new webkitRTCPeerConnection(
            WebRTC_PeerConnection_Servers, WebRTC_PeerConnection_Argument
        );
        info.conn.onicecandidate = function(ev) {
            if (ev.candidate) {
                console.log('[owner] onicecandidate');
                info.wsock.send(JSON.stringify({'ice':JSON.stringify(ev.candidate)}));
            }
        };
        info.conn.ondatachannel = function(ev) {
            info.ch = ev.channel;
            info.ch.onopen = function() {
                if(info.alm.dc_callback) info.alm.dc_callback();
                console.log("DataChannel: onOpen (passive)");
            };
            console.log("onDataChannel Callback");
        };
        info.wsock.onmessage = function(ev) {
            var msg = JSON.parse(ev.data);
            if (msg.ice) {
                console.log('[owner] added ice');
                info.conn.addIceCandidate(new RTCIceCandidate(JSON.parse(msg.ice)));
            }
        };
        info.alm.downstreams.push(info);

        console.log(JSON.parse(offer_sdp));
        offer_desc = new RTCSessionDescription({type:'offer', sdp:JSON.parse(offer_sdp).sdp});
        info.conn.setRemoteDescription(offer_desc);
        info.conn.createAnswer(function(answer_sdp) {
            console.log('created answer: ' + answer_sdp);
            info.conn.setLocalDescription(answer_sdp);
            info.wsock.send(JSON.stringify({'e':info.ekey,'s':JSON.stringify(answer_sdp)}));
        });
    };

};

WebRTC_ALM.prototype.ReceiveMessageFromUpstream = function(ev) {
    console.log('[listener] recv msg from upstream');

    var msg = {'m':'binary-blob'};
    var is_ctrl = false;
    try {
        //msg = JSON.parse(new Zlib.Inflate(ev.data).decompress());
        var str = RawDeflate.inflate(ev.data);
        //console.log("str", str);
        msg = JSON.parse(str);
        if (msg.m && (msg.m == 'new'))
            is_ctrl = true;
    } catch (ex) {}

    if (msg.m == 'new' && this.downstreams.length < this.max_downstreams){
        console.log('[listener] recv new-member req from upstream');
        var info = new WebRTC_ALM_DataChannelInfo(this);
        info.ekey = msg.e;
        info.start_candidate_process(msg.s);
    } else {
        console.log('[listener] relay message-type=' + msg.m);
        if (!is_ctrl){
            if (msg.m == 'blob'){
                this.BlobHandler(msg);
            } else {
                this.handler(ev.data);
            }
        }
        for(var i = 0; i < this.downstreams.length; ++i) {
            this.downstreams[i].ch.send(ev.data);
        }
    }
};

WebRTC_ALM.prototype.BlobHandler = function(msg){
    var owner = this;
    if(!this.blob_table) this.blob_table = {};
    if(!this.blob_table[msg.t]){
        this.blob_table[msg.t] = {};
        this.blob_table[msg.t].expire = setTimeout(function(){
            delete owner.blob_table[msg.t];
        }, 10000); // todo
    }
    this.blob_table[msg.t][msg.i] = msg.d;
    //this.blob_table[msg.t][msg.i] = new Uint8Array(msg.d).buffer;
    if(Object.keys(this.blob_table[msg.t]).length == msg.n){
        console.log("Just completed one blob.");
        clearTimeout(this.blob_table[msg.t].expire);
        var array = new Uint8Array((msg.n-1)*this.chunk_size+
                                   this.blob_table[msg.t][msg.n-1].byteLength);
        for (var i = 0; i < msg.n; ++i) {
            array.set(this.blob_table[msg.t][i], i*this.chunk_size);
        }
        this.handler(new Blob([array]));
        delete this.blob_table[msg.t];
    }
}
