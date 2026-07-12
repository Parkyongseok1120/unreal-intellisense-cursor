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
	void TickAutomation(float DeltaTime);

private:
	bool bRunning = false;
	uint16 Port = 0;
	FString AuthToken;
	FString ProjectId;
	double ProcessStartTime = 0.0;
	FHttpRouteHandle RpcRoute;
	TSharedPtr<IHttpRouter> HttpRouter;

	bool HandleRpcRequest(const FHttpServerRequest& Request, const FHttpResultCallback& OnComplete);
	bool CheckAuth(const FHttpServerRequest& Request) const;
	TSharedPtr<FJsonObject> ProcessRpcMethod(const FString& Method, const TSharedPtr<FJsonObject>& Params);
	void WriteDescriptor() const;
	void DeleteDescriptor() const;
	void RefreshRunningAutomationStates();
};
