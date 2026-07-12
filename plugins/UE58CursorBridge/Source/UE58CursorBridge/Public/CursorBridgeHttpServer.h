#pragma once

#include "CoreMinimal.h"
#include "HttpRouteHandle.h"
#include "HttpServerRequest.h"

class IHttpRouter;

class FCursorBridgeHttpServer
{
public:
	void Start();
	void Stop();
	bool IsRunning() const { return bRunning; }

private:
	bool bRunning = false;
	uint16 Port = 0;
	FString AuthToken;
	FHttpRouteHandle RpcRoute;
	TSharedPtr<IHttpRouter> HttpRouter;

	bool HandleRpcRequest(const FHttpServerRequest& Request, const FHttpResultCallback& OnComplete);
	bool CheckAuth(const FHttpServerRequest& Request) const;
	TSharedPtr<FJsonObject> ProcessRpcMethod(const FString& Method, const TSharedPtr<FJsonObject>& Params) const;
	void WriteDescriptor() const;
};
